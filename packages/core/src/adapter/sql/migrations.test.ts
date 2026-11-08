/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { StorageSchemaTooNewError } from "../../contracts/errors.ts";
import type { SqlDatabase, SqlTransaction } from "./database.ts";
import { sqliteDialect } from "./dialect.ts";
import {
  type MigrateSchemasArgs,
  migrateSchemas,
  type SchemaScope,
  schemaMigrationsTableFor,
} from "./migrations.ts";
import type { SqlExecutor } from "./sql-table.ts";

const table = schemaMigrationsTableFor("app_");

const memoryDatabase = () => {
  const db = new DatabaseSync(":memory:");
  const statements: string[] = [];
  const executor: SqlExecutor = {
    run: async (sql, params) => {
      statements.push(sql);
      db.prepare(sql).run(...(params as SQLInputValue[]));
    },
    all: async (sql, params) => {
      statements.push(sql);
      return db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[];
    },
  };
  let queue: Promise<unknown> = Promise.resolve();
  let locks = 0;
  const database: SqlDatabase = {
    ...executor,
    write: (work) => {
      const next = queue.then(async () => {
        locks += 1;
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await work({ ...executor, raw: db });
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
  return {
    db,
    database,
    statements,
    locks: () => locks,
    versions: () =>
      db
        .prepare(
          `SELECT "scope", "version", "applied_at" FROM ${table} ORDER BY "scope", "version"`,
        )
        .all(),
    tables: () =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name),
  };
};

const creating =
  (name: string, applied: string[] = []) =>
  async (tx: SqlTransaction): Promise<void> => {
    applied.push(name);
    await tx.run(`CREATE TABLE IF NOT EXISTS "${name}" ("id" TEXT)`, []);
  };

const migrate = (
  database: SqlDatabase,
  scopes: readonly SchemaScope[],
  overrides: Partial<MigrateSchemasArgs> = {},
) =>
  migrateSchemas({
    db: database,
    dialect: sqliteDialect,
    table,
    scopes,
    locked: (work) => database.write(work),
    isMissingTable: (error) => error instanceof Error && /no such table/.test(error.message),
    now: () => new Date("2026-11-08T10:00:00.000Z"),
    ...overrides,
  });

describe("migrateSchemas", () => {
  it("applies each scope's migrations in order and records every version with when it came in", async () => {
    const { database, versions, tables } = memoryDatabase();
    const applied: string[] = [];
    await migrate(database, [
      {
        scope: "a",
        migrations: [
          { version: 1, migrate: creating("a1", applied) },
          { version: 2, migrate: creating("a2", applied) },
        ],
      },
      { scope: "b", migrations: [{ version: 1, migrate: creating("b1", applied) }] },
    ]);
    expect(applied).toEqual(["a1", "a2", "b1"]);
    expect(tables()).toEqual(["a1", "a2", "app_migrations", "b1"]);
    expect(versions()).toEqual([
      { scope: "a", version: 1, applied_at: "2026-11-08T10:00:00.000Z" },
      { scope: "a", version: 2, applied_at: "2026-11-08T10:00:00.000Z" },
      { scope: "b", version: 1, applied_at: "2026-11-08T10:00:00.000Z" },
    ]);
  });

  it("reads once and takes no lock when every scope is at its latest version", async () => {
    const { database, statements, locks } = memoryDatabase();
    const scopes = [{ scope: "a", migrations: [{ version: 1, migrate: creating("a1") }] }];
    await migrate(database, scopes);
    statements.length = 0;
    const before = locks();
    await migrate(database, scopes);
    expect(statements).toEqual([
      `SELECT "scope", max("version") AS "version" FROM ${table} GROUP BY "scope"`,
    ]);
    expect(locks()).toBe(before);
  });

  it("applies only the migrations past the version a database is at, one transaction each", async () => {
    const { database, versions, locks } = memoryDatabase();
    await migrate(database, [
      { scope: "a", migrations: [{ version: 1, migrate: creating("a1") }] },
    ]);
    const applied: string[] = [];
    const before = locks();
    await migrate(database, [
      {
        scope: "a",
        migrations: [
          { version: 1, migrate: creating("a1", applied) },
          { version: 2, migrate: creating("a2", applied) },
          { version: 3, migrate: creating("a3", applied) },
        ],
      },
    ]);
    expect(applied).toEqual(["a2", "a3"]);
    expect(locks() - before).toBe(2);
    expect(versions().map((row) => row.version)).toEqual([1, 2, 3]);
  });

  it("rolls back a migration that fails with its version, keeps the ones before, and runs it again next time", async () => {
    const { database, versions, tables } = memoryDatabase();
    const first = { version: 1, migrate: creating("a1") };
    const failing: SchemaScope = {
      scope: "a",
      migrations: [
        first,
        {
          version: 2,
          migrate: async (tx) => {
            await creating("a2")(tx);
            throw new Error("boom");
          },
        },
      ],
    };
    await expect(migrate(database, [failing])).rejects.toThrow("boom");
    expect(tables()).toEqual(["a1", "app_migrations"]);
    expect(versions().map((row) => row.version)).toEqual([1]);
    await migrate(database, [
      { scope: "a", migrations: [first, { version: 2, migrate: creating("a2") }] },
    ]);
    expect(versions().map((row) => row.version)).toEqual([1, 2]);
  });

  it("applies each migration once when instances start together", async () => {
    const { database, versions } = memoryDatabase();
    const applied: string[] = [];
    const scopes = [
      {
        scope: "a",
        migrations: [
          { version: 1, migrate: creating("a1", applied) },
          { version: 2, migrate: creating("a2", applied) },
        ],
      },
    ];
    await Promise.all([
      migrate(database, scopes),
      migrate(database, scopes),
      migrate(database, scopes),
    ]);
    expect(applied).toEqual(["a1", "a2"]);
    expect(versions().map((row) => row.version)).toEqual([1, 2]);
  });

  it("refuses a scope a newer version migrated, before it writes or locks anything", async () => {
    const { db, database, locks, tables } = memoryDatabase();
    await migrate(database, [
      { scope: "a", migrations: [{ version: 1, migrate: creating("a1") }] },
    ]);
    db.exec(`INSERT INTO ${table} VALUES ('a', 7, 'later')`);
    const before = locks();
    const refused = migrate(database, [
      { scope: "b", migrations: [{ version: 1, migrate: creating("b1") }] },
      { scope: "a", migrations: [{ version: 1, migrate: creating("a1") }] },
    ]);
    await expect(refused).rejects.toBeInstanceOf(StorageSchemaTooNewError);
    await expect(refused).rejects.toMatchObject({
      code: "STORAGE_SCHEMA_TOO_NEW",
      scope: "a",
      version: 7,
      supported: 1,
    });
    expect(locks()).toBe(before);
    expect(tables()).toEqual(["a1", "app_migrations"]);
  });

  it("refuses when a newer version migrated while it waited for the lock, applying nothing", async () => {
    const { db, database, tables } = memoryDatabase();
    const refused = migrate(
      database,
      [{ scope: "a", migrations: [{ version: 1, migrate: creating("a1") }] }],
      {
        locked: (work) =>
          database.write(async (tx) => {
            db.exec(
              `CREATE TABLE IF NOT EXISTS ${table} ("scope" TEXT, "version" INTEGER, "applied_at" TEXT)`,
            );
            db.exec(`INSERT INTO ${table} VALUES ('a', 2, 'meanwhile')`);
            return work(tx);
          }),
      },
    );
    await expect(refused).rejects.toMatchObject({ scope: "a", version: 2, supported: 1 });
    expect(tables()).toEqual([]);
  });

  it("leaves alone the scopes it does not migrate", async () => {
    const { db, database, versions } = memoryDatabase();
    await migrate(database, [
      { scope: "a", migrations: [{ version: 1, migrate: creating("a1") }] },
    ]);
    db.exec(`INSERT INTO ${table} VALUES ('other', 99, 'elsewhere')`);
    await migrate(database, [
      { scope: "a", migrations: [{ version: 1, migrate: creating("a1") }] },
    ]);
    expect(versions().map(({ scope, version }) => [scope, version])).toEqual([
      ["a", 1],
      ["other", 99],
    ]);
  });

  it("rethrows a failure to read the versions other than a missing table", async () => {
    const { database } = memoryDatabase();
    await expect(
      migrate(database, [{ scope: "a", migrations: [{ version: 1, migrate: creating("a1") }] }], {
        isMissingTable: () => false,
      }),
    ).rejects.toThrow(/no such table/);
  });
});
