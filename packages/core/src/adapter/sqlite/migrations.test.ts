/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../sql/database.ts";
import { schemaMigrationsTableFor } from "../sql/migrations.ts";
import {
  migrateSqlite,
  sqliteCheckpointsScope,
  sqliteForgetLedgerScope,
  sqliteStorageScope,
} from "./migrations.ts";
import { storageTablesFor } from "./schema.ts";

const busy = Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });

const onNodeSqlite = () => {
  const db = new DatabaseSync(":memory:");
  const run = async (sql: string, params: readonly unknown[]) => {
    db.prepare(sql).run(...(params as SQLInputValue[]));
  };
  const all = async (sql: string, params: readonly unknown[]) =>
    db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[];
  const database: SqlDatabase = {
    run,
    all,
    write: async (work) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await work({ run, all, raw: db });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, database };
};

describe("migrateSqlite", () => {
  it("waits for another process's migration, trying its write again while the database is busy", async () => {
    const { database, db } = onNodeSqlite();
    let refusals = 2;
    const slept: number[] = [];
    await migrateSqlite({
      db: {
        ...database,
        write: (work) => {
          if (refusals > 0) {
            refusals -= 1;
            return Promise.reject(busy);
          }
          return database.write(work);
        },
      },
      isBusy: (error) => error === busy,
      prefix: "app_",
      scopes: [sqliteCheckpointsScope('"app_checkpoints"')],
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toHaveLength(2);
    for (const ms of slept) expect(ms).toBeGreaterThanOrEqual(5);
    expect(
      db.prepare(`SELECT "scope", "version" FROM ${schemaMigrationsTableFor("app_")}`).all(),
    ).toEqual([{ scope: "checkpoints", version: 1 }]);
  });

  it("fails at once on any other error, and on a busy database when the connection is the only writer", async () => {
    const { database } = onNodeSqlite();
    const failing = (error: Error): SqlDatabase => ({
      ...database,
      write: () => Promise.reject(error),
    });
    const scopes = [sqliteCheckpointsScope('"app_checkpoints"')];
    await expect(
      migrateSqlite({
        db: failing(new Error("disk I/O error")),
        isBusy: (error) => error === busy,
        prefix: "app_",
        scopes,
      }),
    ).rejects.toThrow("disk I/O error");
    await expect(migrateSqlite({ db: failing(busy), prefix: "app_", scopes })).rejects.toBe(busy);
  });

  it("creates the forget ledger's table in its own scope, apart from the storage", async () => {
    const { database, db } = onNodeSqlite();
    await migrateSqlite({
      db: database,
      prefix: "app_",
      scopes: [sqliteForgetLedgerScope('"app_forget_ledger"')],
    });
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'app_%' ORDER BY name")
        .all()
        .map((row) => row.name),
    ).toEqual(["app_forget_ledger", "app_forget_ledger_order_idx", "app_migrations"]);
  });
});

describe("the SQLite schema scopes", () => {
  it("number their migrations from 1, with no gap", () => {
    for (const { migrations } of [
      sqliteStorageScope(storageTablesFor("bounda_")),
      sqliteCheckpointsScope('"bounda_checkpoints"'),
      sqliteForgetLedgerScope('"bounda_forget_ledger"'),
    ]) {
      expect(migrations.map(({ version }) => version)).toEqual(
        migrations.map((_, index) => index + 1),
      );
    }
  });
});
