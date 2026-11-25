import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@bounda-dev/core";
import type { FileKey, FileKeyAccess } from "@bounda-dev/core/adapter";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeConnectionsOnce } from "./close-once.ts";
import { prepareFile } from "./encryption.ts";

// The key each connection the client opens on a file is given, `null` for none.
const opened = vi.hoisted(() => ({ keys: new Map<string, (string | null)[]>() }));

vi.mock("@libsql/client", async (actual) => {
  const module = await actual<typeof import("@libsql/client")>();
  return {
    ...module,
    createClient: (config: Parameters<typeof module.createClient>[0]) => {
      const keys = opened.keys.get(config.url) ?? [];
      keys.push(config.encryptionKey ?? null);
      opened.keys.set(config.url, keys);
      return module.createClient(config);
    },
  };
});

const A: FileKey = { id: "f-a", key: "a".repeat(64) };
const B: FileKey = { id: "f-b", key: "b".repeat(64) };
const C: FileKey = { id: "f-c", key: "c".repeat(64) };

let directory: string;
let files = 0;

beforeAll(async () => {
  closeConnectionsOnce();
  directory = await mkdtemp(join(tmpdir(), "bounda-key-trials-"));
});

beforeEach(() => {
  opened.keys.clear();
});

afterAll(async () => {
  // Windows cannot delete a file a connection not yet collected still holds.
  await rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
  });
});

// A file with one row under `key`, `null` for none, written by a process of its own, which lets go
// of it as it exits.
const fileUnder = async (key: string | null): Promise<string> => {
  files += 1;
  const path = join(directory, `store-${files}.db`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createClient } from "@libsql/client";
        import { closeConnectionsOnce } from "./close-once.ts";
        closeConnectionsOnce();
        const client = createClient(${JSON.stringify({ url: `file:${path}`, ...(key === null ? {} : { encryptionKey: key }) })});
        await client.execute("PRAGMA journal_mode = WAL");
        await client.execute("CREATE TABLE t (x INTEGER)");
        await client.execute("INSERT INTO t VALUES (1)");
        client.close();`,
      ],
      { cwd: import.meta.dirname, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`the writer exited with ${code}`)),
    );
  });
  return path;
};

const keysOf = (current: FileKey, previous: readonly FileKey[] = []): FileKeyAccess => ({
  tenant: "default",
  current: async () => current,
  previous: async () => previous,
  confirm: async () => undefined,
});

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// The keys `prepareFile` opened the file itself under, in order, and the key it ended under.
const trials = async (path: string, keys: FileKeyAccess) => {
  const prepared = await prepareFile({ path, keys, logger: silent, tenancy: '"bounda_tenancy"' });
  if ("gone" in prepared) throw new Error("the keys are gone");
  prepared.client.close();
  return { opened: opened.keys.get(`file:${path}`), under: prepared.under?.key ?? null };
};

describe("the keys prepareFile tries on a file", () => {
  it("opens a file in the clear in the clear alone, then encrypts it", async () => {
    expect(await trials(await fileUnder(null), keysOf(A))).toEqual({
      opened: [null],
      under: A.key,
    });
  });

  it("opens a file under an earlier key under that key alone", async () => {
    expect(await trials(await fileUnder(A.key), keysOf(B, [C, A]))).toEqual({
      opened: [A.key],
      under: B.key,
    });
  });

  it("opens a file under the key in force under that key alone", async () => {
    expect(await trials(await fileUnder(B.key), keysOf(B, [A]))).toEqual({
      opened: [B.key],
      under: B.key,
    });
  });

  it("tries first, on the file itself, the key a cut-short encryption names, though its pages read under another", async () => {
    const path = await fileUnder(B.key);
    await writeFile(`${path}.bounda-encrypting`, JSON.stringify({ from: A.id }));
    expect(await trials(path, keysOf(B, [A]))).toEqual({ opened: [A.key, B.key], under: B.key });
  });

  it("still tries on the file itself every key its pages rule out, before giving up", async () => {
    const path = await fileUnder(C.key);
    await expect(trials(path, keysOf(B, [A]))).rejects.toThrow(
      "opens under none of its tenant's keys",
    );
    expect(opened.keys.get(`file:${path}`)).toEqual([B.key, A.key, null]);
  });
});
