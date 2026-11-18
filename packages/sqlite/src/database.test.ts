import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient, type ResultSet } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqliteDatabase } from "./database.ts";

const WAL = "PRAGMA journal_mode = WAL";

const failure = (code: string): Error => Object.assign(new Error(code), { code });

const empty = { rows: [], columns: [] } as unknown as ResultSet;

// A client whose WAL switch fails with each of `switching` in turn, then succeeds.
const fakeClient = (switching: readonly Error[]) => {
  const statements: string[] = [];
  const left = [...switching];
  const execute = async (statement: string | { readonly sql: string }): Promise<ResultSet> => {
    const sql = typeof statement === "string" ? statement : statement.sql;
    statements.push(sql);
    const error = sql === WAL ? left.shift() : undefined;
    if (error !== undefined) throw error;
    return empty;
  };
  return { client: { execute } as unknown as Client, statements };
};

describe("createSqliteDatabase on a file", () => {
  it("switches to WAL before the first statement, trying again while another connection holds the file", async () => {
    const { client, statements } = fakeClient([failure("SQLITE_BUSY"), failure("SQLITE_BUSY")]);
    const { db } = createSqliteDatabase(client, { local: true, wal: true });
    await db.all("SELECT 1", []);
    await db.run("SELECT 2", []);
    expect(statements).toEqual([WAL, WAL, WAL, "SELECT 1", "SELECT 2"]);
  });

  it("fails the first statement on any other error, and switches again on the next one", async () => {
    const { client, statements } = fakeClient([failure("SQLITE_IOERR")]);
    const { db } = createSqliteDatabase(client, { local: true, wal: true });
    await expect(db.all("SELECT 1", [])).rejects.toMatchObject({ code: "SQLITE_IOERR" });
    await db.all("SELECT 2", []);
    expect(statements).toEqual([WAL, WAL, "SELECT 2"]);
  });

  it("takes only the driver's own busy error for a busy file", async () => {
    const { client, statements } = fakeClient([{ code: "SQLITE_BUSY" } as unknown as Error]);
    const { db } = createSqliteDatabase(client, { local: true, wal: true });
    await expect(db.all("SELECT 1", [])).rejects.toEqual({ code: "SQLITE_BUSY" });
    expect(statements).toEqual([WAL]);
  });

  it("never switches a database that is not a file", async () => {
    const { client, statements } = fakeClient([]);
    const { db } = createSqliteDatabase(client, { local: true, wal: false });
    await db.all("SELECT 1", []);
    expect(statements).toEqual(["SELECT 1"]);
  });
});

describe("createSqliteDatabase after a statement fails", () => {
  it("opens the client's connections afresh after a busy statement on a file, and only then", async () => {
    for (const wal of [true, false]) {
      let reconnected = 0;
      const execute = async (statement: string | { readonly sql: string }): Promise<ResultSet> => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (sql === "BUSY") throw failure("SQLITE_BUSY");
        if (sql === "BAD") throw failure("SQLITE_ERROR");
        return empty;
      };
      const client = {
        execute,
        reconnect: () => {
          reconnected += 1;
        },
      } as unknown as Client;
      const { db } = createSqliteDatabase(client, { local: true, wal });
      await expect(db.run("BAD", [])).rejects.toMatchObject({ code: "SQLITE_ERROR" });
      expect(reconnected).toBe(0);
      await expect(db.run("BUSY", [])).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      expect(reconnected).toBe(wal ? 1 : 0);
    }
  });
});

// Another process's write transaction on the file, held for `holdMs`: resolves once it holds the
// lock, and `done` once it committed.
const foreignWrite = async (path: string, holdMs: number) => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
db.exec("BEGIN IMMEDIATE");
db.exec("INSERT INTO notes (text) VALUES ('foreign')");
process.stdout.write("held\\n");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, Number(process.argv[2]));`,
      path,
      String(holdMs),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const done = new Promise<void>((resolve, reject) => {
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`the other process exited with ${code}`)),
    );
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
  });
  return { done };
};

const notesOf = async (client: Client): Promise<readonly string[]> =>
  (await client.execute("SELECT text FROM notes ORDER BY id")).rows.map(({ text }) => String(text));

describe("createSqliteDatabase on a file another process writes to", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "bounda-busy-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });

  it.each(["run", "write"] as const)(
    "keeps what it writes after a %s waited past the busy timeout, for every connection to read",
    async (via) => {
      const path = join(directory, `${via}.db`);
      const client = createClient({ url: `file:${path}`, timeout: 100 });
      const { db } = createSqliteDatabase(client, { local: true, wal: true });
      await db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)", []);
      const other = await foreignWrite(path, 1_000);
      const insert = (text: string): Promise<unknown> =>
        via === "run"
          ? db.run("INSERT INTO notes (text) VALUES (?)", [text])
          : db.write((tx) => tx.run("INSERT INTO notes (text) VALUES (?)", [text]));
      await expect(insert("refused")).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      await other.done;
      await insert("kept");
      const reader = createClient({ url: `file:${path}` });
      try {
        expect(await notesOf(reader)).toEqual(["foreign", "kept"]);
        client.close();
        expect(await notesOf(reader)).toEqual(["foreign", "kept"]);
      } finally {
        reader.close();
      }
    },
  );
});
