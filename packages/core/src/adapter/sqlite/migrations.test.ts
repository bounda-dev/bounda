/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../sql/database.ts";
import { schemaMigrationsTableFor } from "../sql/migrations.ts";
import {
  migrateSqlite,
  replaySqlite,
  sqliteCheckpointsScope,
  sqliteForgetLedgerScope,
  sqliteSchemaScopesFor,
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
      scopes: [sqliteCheckpointsScope(storageTablesFor("app_"))],
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toHaveLength(2);
    for (const ms of slept) expect(ms).toBeGreaterThanOrEqual(5);
    expect(
      db.prepare(`SELECT "scope", "version" FROM ${schemaMigrationsTableFor("app_")}`).all(),
    ).toEqual([
      { scope: "checkpoints", version: 1 },
      { scope: "checkpoints", version: 2 },
      { scope: "checkpoints", version: 3 },
      { scope: "checkpoints", version: 4 },
    ]);
  });

  it("fails at once on any other error, and on a busy database when the connection is the only writer", async () => {
    const { database } = onNodeSqlite();
    const failing = (error: Error): SqlDatabase => ({
      ...database,
      write: () => Promise.reject(error),
    });
    const scopes = [sqliteCheckpointsScope(storageTablesFor("app_"))];
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

  it("reads a missing versions table as an unversioned database, and rethrows any other failure to read it", async () => {
    const { database } = onNodeSqlite();
    const scopes = [sqliteCheckpointsScope(storageTablesFor("app_"))];
    await expect(
      migrateSqlite({
        db: { ...database, all: () => Promise.reject(new Error("disk I/O error")) },
        prefix: "app_",
        scopes,
      }),
    ).rejects.toThrow("disk I/O error");
    await expect(
      migrateSqlite({
        db: { ...database, all: () => Promise.reject("no such table: thrown as text") },
        prefix: "app_",
        scopes,
      }),
    ).rejects.toBe("no such table: thrown as text");
    await expect(migrateSqlite({ db: database, prefix: "app_", scopes })).resolves.toBeUndefined();
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
    ).toEqual([
      "app_forget_ledger",
      "app_forget_ledger_fence",
      "app_forget_ledger_marks",
      "app_forget_ledger_order_idx",
      "app_migrations",
    ]);
  });
});

describe("the superseded keys' table", () => {
  it("is indexed by person and successor under a name of its own", async () => {
    const { database, db } = onNodeSqlite();
    await migrateSqlite({
      db: database,
      prefix: "app_",
      scopes: [sqliteStorageScope(storageTablesFor("app_"))],
    });
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
        .all("app_superseded_keys")
        .map((row) => row.name),
    ).toContain("app_superseded_keys_successor_idx");
  });
});

describe("the personal keys' table", () => {
  it("is indexed under the same names whether created in one pass or migrated", async () => {
    const tables = storageTablesFor("app_");
    const indexes = async (
      run: (database: SqlDatabase) => Promise<void>,
    ): Promise<readonly unknown[]> => {
      const { database, db } = onNodeSqlite();
      await run(database);
      return db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
        )
        .all(tables.personalKeys.slice(1, -1))
        .map((row) => row.name);
    };
    const named = [
      "app_personal_keys_due_idx",
      "app_personal_keys_held_idx",
      "app_personal_keys_in_force_idx",
      "app_personal_keys_kid_idx",
      "app_personal_keys_retained_idx",
    ];
    const scopes = [sqliteStorageScope(tables)];
    expect(await indexes((db) => migrateSqlite({ db, prefix: "app_", scopes }))).toEqual(named);
    expect(await indexes((db) => replaySqlite({ db, prefix: "app_", scopes }))).toEqual(named);
  });
});

describe("the SQLite schema scopes", () => {
  it("number their migrations from 1, with no gap", () => {
    for (const { migrations } of Object.values(sqliteSchemaScopesFor("bounda_"))) {
      expect(migrations.length).toBeGreaterThan(0);
      expect(migrations.map(({ version }) => version)).toEqual(
        migrations.map((_, index) => index + 1),
      );
    }
  });

  it("name as their latest tables every table their migrations leave, and no other", async () => {
    for (const scope of Object.values(sqliteSchemaScopesFor("app_"))) {
      const { database, db } = onNodeSqlite();
      await replaySqlite({ db: database, prefix: "app_", scopes: [scope] });
      const left = db
        .prepare(
          `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT IN ('app_migrations', 'sqlite_sequence')`,
        )
        .all()
        .map(({ name }) => `"${String(name)}"`);
      expect([...scope.latest.tables].sort()).toEqual(left.sort());
    }
  });

  it("takes the forget ledger's disclosure column as there already, from a migration that stopped before recording its version", async () => {
    const { database, db } = onNodeSqlite();
    const migrate = () =>
      migrateSqlite({
        db: database,
        prefix: "app_",
        scopes: [sqliteForgetLedgerScope(`"app_forget_ledger"`)],
      });
    await migrate();
    db.prepare(
      `DELETE FROM ${schemaMigrationsTableFor("app_")} WHERE "scope" = 'forget-ledger' AND "version" = 7`,
    ).run();
    await migrate();
    expect(
      db
        .prepare(
          `SELECT "version" FROM ${schemaMigrationsTableFor("app_")} WHERE "scope" = 'forget-ledger' ORDER BY "version" DESC LIMIT 1`,
        )
        .get(),
    ).toEqual({ version: 9 });
  });
});
