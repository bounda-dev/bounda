import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError, silentLogger } from "@bounda-dev/core";
import type { FileKeyAccess } from "@bounda-dev/core/adapter";
import { type Client, createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLibsqlCopy } from "./copy.ts";
import { sqlite } from "./index.ts";

let directory: string;
let files = 0;
const clients: Client[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bounda-copy-"));
});

afterAll(async () => {
  for (const client of clients) client.close();
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

const fresh = (name: string): string => {
  files += 1;
  return join(directory, `${name}-${files}.db`);
};

// A file with one row, under `key` or in the clear.
const fileUnder = async (key: string | null, note = "kept"): Promise<string> => {
  const path = fresh("copy");
  const client = createClient({
    url: `file:${path}`,
    ...(key === null ? {} : { encryptionKey: key }),
  });
  clients.push(client);
  await client.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT, big INTEGER)");
  await client.execute({
    sql: "INSERT INTO notes (text, big) VALUES (?, ?)",
    args: [note, 9_007_199_254_740_993n],
  });
  return path;
};

describe("openLibsqlCopy", () => {
  it("opens a copy under the first key it opens under, reading integers as they are stored", async () => {
    for (const [key, keys] of [
      ["second", ["first", "second", null]],
      [null, ["first", null]],
    ] as const) {
      const copy = await openLibsqlCopy({ copy: await fileUnder(key), keys });
      expect(await copy.db.all("SELECT text, big FROM notes WHERE id = ?", [1])).toEqual([
        { text: "kept", big: 9_007_199_254_740_993n },
      ]);
      await copy.close();
      // Closed: it reads no more.
      await expect(copy.db.all("SELECT 1", [])).rejects.toThrow();
    }
  });

  it("refuses a copy that is not there, one that opens under none of the keys, and fails on one that cannot open at all", async () => {
    const missing = fresh("missing");
    await expect(openLibsqlCopy({ copy: missing, keys: [null] })).rejects.toThrow(
      new ConfigurationError(`There is no copy at ${missing}`),
    );
    const other = await fileUnder("another");
    await expect(openLibsqlCopy({ copy: other, keys: ["first", null] })).rejects.toThrow(
      new ConfigurationError(
        `The copy at ${other} opens under none of its tenant's keys: it is another tenant's, or not a database`,
      ),
    );
    // A copy another connection holds exclusively fails as libSQL says, not as one that is no
    // database.
    const locked = await fileUnder(null);
    const holder = createClient({ url: `file:${locked}`, concurrency: 1 });
    await holder.execute("PRAGMA journal_mode = DELETE");
    await holder.execute("PRAGMA locking_mode = EXCLUSIVE");
    await holder.execute("UPDATE notes SET text = 'held'");
    await expect(openLibsqlCopy({ copy: locked, keys: [null] })).rejects.toMatchObject({
      code: "SQLITE_BUSY",
    });
    holder.close();
    const garbage = fresh("garbage");
    writeFileSync(garbage, "not a database, as long as a page".repeat(200));
    await expect(openLibsqlCopy({ copy: garbage, keys: [null] })).rejects.toThrow(
      ConfigurationError,
    );
  });
});

describe("restoring a libSQL file in place", () => {
  it("is only offered for a file", () => {
    expect(sqlite({ memory: true }).restore).toBeUndefined();
    expect(
      sqlite({ url: "libsql://example.turso.io", authToken: "token" }).restore,
    ).toBeUndefined();
    expect(sqlite({ path: fresh("plain"), encrypt: false }).restore).toBeTypeOf("function");
  });

  it("opens a copy under an earlier key of the tenant's, or one from before the file was encrypted", async () => {
    const keys: FileKeyAccess = {
      tenant: "default",
      current: async () => ({ id: "k-2", key: "second" }),
      previous: async () => [{ id: "k-1", key: "first" }],
      confirm: async () => undefined,
    };
    const path = fresh("live");
    const opened = await sqlite({ path }).encryptedFile?.open({ keys, logger: silentLogger });
    if (opened === undefined) throw new Error("the file did not open");
    await (await opened.createStorage()).close();
    const reader = createClient({ url: `file:${path}`, encryptionKey: "second" });
    clients.push(reader);
    for (const [key, note] of [
      ["first", "under the earlier key"],
      [null, "in the clear"],
    ] as const) {
      await opened.restore?.({ copy: await fileUnder(key, note) });
      // Still under the key in force, holding the copy's rows.
      expect((await reader.execute("SELECT text FROM notes")).rows.map(({ text }) => text)).toEqual(
        [note],
      );
    }
  });
});
