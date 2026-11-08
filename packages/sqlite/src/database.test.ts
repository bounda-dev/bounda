import type { Client, ResultSet } from "@libsql/client";
import { describe, expect, it } from "vitest";
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
