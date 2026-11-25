/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { StorageSchemaTooNewError } from "../../contracts/errors.ts";
import type { SqlDatabase, SqlTransaction } from "./database.ts";
import { sqliteDialect } from "./dialect.ts";
import {
  type MigrateSchemasArgs,
  migrateSchemas,
  replaySchemas,
  type SchemaMigration,
  type SchemaScope,
  schemaMigrationsTableFor,
  schemaMigrationsTableStatement,
} from "./migrations.ts";
import type { SqlFragment } from "./query-builder.ts";
import type { SqlExecutor } from "./sql-table.ts";

const table = schemaMigrationsTableFor("app_");

const memoryDatabase = ({ batching = false } = {}) => {
  const db = new DatabaseSync(":memory:");
  const statements: string[] = [];
  const batches: (readonly SqlFragment[])[] = [];
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
          const result = await work({
            ...executor,
            raw: db,
            ...(batching
              ? {
                  batch: async (fragments: readonly SqlFragment[]) => {
                    batches.push(fragments);
                    for (const { sql, params } of fragments) {
                      db.prepare(sql).run(...(params as SQLInputValue[]));
                    }
                  },
                }
              : {}),
          });
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
    batches,
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

// A scope whose migration `n` creates the table `<scope><n>`, and whose latest schema creates them
// all, plus `latest` for one that adds what no migration does.
const scopeOf = (
  scope: string,
  count: number,
  { applied = [], latest = [] }: { applied?: string[]; latest?: readonly string[] } = {},
): SchemaScope => {
  const names = Array.from({ length: count }, (_, index) => `${scope}${index + 1}`);
  return {
    scope,
    migrations: names.map(
      (name, index): SchemaMigration => ({ version: index + 1, migrate: creating(name, applied) }),
    ),
    latest: {
      tables: [...names, ...latest].map((name) => `"${name}"`),
      statements: [...names, ...latest].map((name) => `CREATE TABLE "${name}" ("id" TEXT)`),
    },
  };
};

const sqliteArgs = (database: SqlDatabase, scopes: readonly SchemaScope[]): MigrateSchemasArgs => ({
  db: database,
  dialect: sqliteDialect,
  table,
  scopes,
  locked: (work) => database.write(work),
  isMissingTable: (error) => error instanceof Error && /no such table/.test(error.message),
  tablesIn: async (executor) =>
    new Set(
      (await executor.all(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`, [])).map(
        (row) => String(row.name),
      ),
    ),
  now: () => new Date("2026-11-08T10:00:00.000Z"),
});

const migrate = (
  database: SqlDatabase,
  scopes: readonly SchemaScope[],
  overrides: Partial<MigrateSchemasArgs> = {},
) => migrateSchemas({ ...sqliteArgs(database, scopes), ...overrides });

const replay = (
  database: SqlDatabase,
  scopes: readonly SchemaScope[],
  overrides: Partial<MigrateSchemasArgs> = {},
) => replaySchemas({ ...sqliteArgs(database, scopes), ...overrides });

const recorded = [
  { scope: "a", version: 1, applied_at: "2026-11-08T10:00:00.000Z" },
  { scope: "a", version: 2, applied_at: "2026-11-08T10:00:00.000Z" },
  { scope: "b", version: 1, applied_at: "2026-11-08T10:00:00.000Z" },
];

describe("replaySchemas", () => {
  it("applies each scope's migrations in order and records every version with when it came in", async () => {
    const { database, versions, tables } = memoryDatabase();
    const applied: string[] = [];
    await replay(database, [scopeOf("a", 2, { applied }), scopeOf("b", 1, { applied })]);
    expect(applied).toEqual(["a1", "a2", "b1"]);
    expect(tables()).toEqual(["a1", "a2", "app_migrations", "b1"]);
    expect(versions()).toEqual(recorded);
  });

  it("reads once and takes no lock when every scope is at its latest version", async () => {
    const { database, statements, locks } = memoryDatabase();
    await replay(database, [scopeOf("a", 1)]);
    statements.length = 0;
    const before = locks();
    await replay(database, [scopeOf("a", 1)]);
    expect(statements).toEqual([
      `SELECT "scope", max("version") AS "version" FROM ${table} GROUP BY "scope"`,
    ]);
    expect(locks()).toBe(before);
  });

  it("applies only the migrations past the version a database is at, in one transaction for the scope", async () => {
    const { database, versions, locks } = memoryDatabase();
    await replay(database, [scopeOf("a", 1)]);
    const applied: string[] = [];
    const before = locks();
    await replay(database, [scopeOf("a", 3, { applied })]);
    expect(applied).toEqual(["a2", "a3"]);
    expect(locks() - before).toBe(1);
    expect(versions().map((row) => row.version)).toEqual([1, 2, 3]);
  });

  it("goes on from the version it reads under the lock, past those another instance applied meanwhile", async () => {
    const { db, database, versions, locks } = memoryDatabase();
    await replay(database, [scopeOf("a", 1)]);
    const applied: string[] = [];
    const before = locks();
    await replay(database, [scopeOf("a", 3, { applied })], {
      locked: (work) =>
        database.write(async (tx) => {
          if (locks() === before + 1) {
            db.exec(`INSERT INTO ${table} VALUES ('a', 2, 'meanwhile')`);
          }
          return work(tx);
        }),
    });
    expect(applied).toEqual(["a3"]);
    expect(locks() - before).toBe(1);
    expect(versions().map((row) => row.version)).toEqual([1, 2, 3]);
  });

  it("rolls back every migration of a scope that fails part-way with their versions, keeps the scopes before it, and runs them again next time", async () => {
    const { database, versions, tables } = memoryDatabase({ batching: true });
    const failing: SchemaScope = {
      ...scopeOf("a", 3),
      migrations: [
        { version: 1, migrate: creating("a1") },
        { version: 2, migrate: creating("a2") },
        {
          version: 3,
          migrate: async (tx) => {
            await creating("a3")(tx);
            throw new Error("boom");
          },
        },
      ],
    };
    await expect(replay(database, [scopeOf("b", 1), failing])).rejects.toThrow("boom");
    expect(tables()).toEqual(["app_migrations", "b1"]);
    expect(versions().map(({ scope, version }) => `${scope}${version}`)).toEqual(["b1"]);
    await replay(database, [scopeOf("b", 1), scopeOf("a", 3)]);
    expect(versions().map(({ scope, version }) => `${scope}${version}`)).toEqual([
      "a1",
      "a2",
      "a3",
      "b1",
    ]);
  });

  it("rolls back a scope whose write fails part-way, even when its migration catches the failure", async () => {
    const { database, versions, tables } = memoryDatabase({ batching: true });
    const failing: SchemaScope = {
      ...scopeOf("a", 3),
      migrations: [
        { version: 1, migrate: creating("a1") },
        {
          version: 2,
          migrate: async (tx) => {
            await tx.run('INSERT INTO "missing" VALUES (1)', []);
            await tx.all("SELECT 1", []).catch(() => []);
          },
        },
        { version: 3, migrate: creating("a3") },
      ],
    };
    await expect(replay(database, [failing])).rejects.toThrow(/no such table: missing/);
    expect(tables()).toEqual([]);
    expect(versions).toThrow(/no such table/);
  });

  it("sends a scope's writes and versions to the driver together, up to each read a migration makes", async () => {
    const { database, batches } = memoryDatabase({ batching: true });
    await replay(database, [scopeOf("a", 1)]);
    batches.length = 0;
    const reading: SchemaScope = {
      ...scopeOf("a", 4),
      migrations: [
        ...scopeOf("a", 2).migrations,
        {
          version: 3,
          migrate: async (tx) => {
            expect(
              await tx.all(`SELECT "name" FROM sqlite_master WHERE "name" = 'a2'`, []),
            ).toEqual([{ name: "a2" }]);
            await creating("a3")(tx);
          },
        },
        { version: 4, migrate: creating("a4") },
      ],
    };
    await replay(database, [reading], { now: () => new Date("2026-11-25T08:00:00.000Z") });
    expect(batches.map((batch) => batch.map(({ sql, params }) => [sql, params]))).toEqual([
      [[schemaMigrationsTableStatement(table), []]],
      [['CREATE TABLE IF NOT EXISTS "a2" ("id" TEXT)', []]],
      [
        ['CREATE TABLE IF NOT EXISTS "a3" ("id" TEXT)', []],
        ['CREATE TABLE IF NOT EXISTS "a4" ("id" TEXT)', []],
        [
          `INSERT INTO ${table} ("scope", "version", "applied_at") VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
          [
            "a",
            2,
            "2026-11-25T08:00:00.000Z",
            "a",
            3,
            "2026-11-25T08:00:00.000Z",
            "a",
            4,
            "2026-11-25T08:00:00.000Z",
          ],
        ],
      ],
    ]);
  });

  it("applies each migration once when instances start together", async () => {
    const { database, versions } = memoryDatabase();
    const applied: string[] = [];
    const scopes = [scopeOf("a", 2, { applied })];
    await Promise.all([
      replay(database, scopes),
      replay(database, scopes),
      replay(database, scopes),
    ]);
    expect(applied).toEqual(["a1", "a2"]);
    expect(versions().map((row) => row.version)).toEqual([1, 2]);
  });

  it("refuses a scope a newer version migrated, before it writes or locks anything", async () => {
    const { db, database, locks, tables } = memoryDatabase();
    await replay(database, [scopeOf("a", 1)]);
    db.exec(`INSERT INTO ${table} VALUES ('a', 7, 'later')`);
    const before = locks();
    const refused = replay(database, [scopeOf("b", 1), scopeOf("a", 1)]);
    await expect(refused).rejects.toBeInstanceOf(StorageSchemaTooNewError);
    await expect(refused).rejects.toMatchObject({
      code: "STORAGE_SCHEMA_TOO_NEW",
      scope: "a",
      version: 7,
      supported: 1,
    });
    await expect(refused).rejects.toThrow(
      'The Bounda tables of "a" are at schema version 7, newer than the 1 this version of Bounda supports',
    );
    expect(locks()).toBe(before);
    expect(tables()).toEqual(["a1", "app_migrations"]);
  });

  it("refuses when a newer version migrated while it waited for the lock, applying nothing", async () => {
    const { db, database, tables } = memoryDatabase();
    const refused = replay(database, [scopeOf("a", 1)], {
      locked: (work) =>
        database.write(async (tx) => {
          db.exec(
            `CREATE TABLE IF NOT EXISTS ${table} ("scope" TEXT, "version" INTEGER, "applied_at" TEXT)`,
          );
          db.exec(`INSERT INTO ${table} VALUES ('a', 2, 'meanwhile')`);
          return work(tx);
        }),
    });
    await expect(refused).rejects.toMatchObject({ scope: "a", version: 2, supported: 1 });
    expect(tables()).toEqual([]);
  });

  it("leaves alone the scopes it does not migrate", async () => {
    const { db, database, versions } = memoryDatabase();
    await replay(database, [scopeOf("a", 1)]);
    db.exec(`INSERT INTO ${table} VALUES ('other', 99, 'elsewhere')`);
    await replay(database, [scopeOf("a", 1)]);
    expect(versions().map(({ scope, version }) => [scope, version])).toEqual([
      ["a", 1],
      ["other", 99],
    ]);
  });

  it("rethrows a failure to read the versions other than a missing table", async () => {
    const { database } = memoryDatabase();
    await expect(
      replay(database, [scopeOf("a", 1)], { isMissingTable: () => false }),
    ).rejects.toThrow(/no such table/);
  });
});

describe("migrateSchemas", () => {
  it("creates the scopes a new database holds none of as they stand at their latest version, in one transaction, and records every version", async () => {
    const { database, versions, tables, locks } = memoryDatabase();
    const applied: string[] = [];
    await migrate(database, [
      scopeOf("a", 2, { applied, latest: ["a_only"] }),
      scopeOf("b", 1, { applied }),
    ]);
    expect(applied).toEqual([]);
    expect(locks()).toBe(1);
    expect(tables()).toEqual(["a1", "a2", "a_only", "app_migrations", "b1"]);
    expect(versions()).toEqual(recorded);
  });

  it("sends every statement of a new database to the driver together, the versions' table first", async () => {
    const { database, batches } = memoryDatabase({ batching: true });
    await migrate(database, [scopeOf("a", 2), scopeOf("b", 1)]);
    expect(batches).toEqual([
      [
        {
          sql: `CREATE TABLE IF NOT EXISTS ${table} (
    "scope" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "applied_at" TEXT NOT NULL,
    PRIMARY KEY ("scope", "version")
  )`,
          params: [],
        },
        { sql: 'CREATE TABLE "a1" ("id" TEXT)', params: [] },
        { sql: 'CREATE TABLE "a2" ("id" TEXT)', params: [] },
        { sql: 'CREATE TABLE "b1" ("id" TEXT)', params: [] },
        {
          sql: `INSERT INTO ${table} ("scope", "version", "applied_at") VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
          params: [
            ...["a", 1, "2026-11-08T10:00:00.000Z"],
            ...["a", 2, "2026-11-08T10:00:00.000Z"],
            ...["b", 1, "2026-11-08T10:00:00.000Z"],
          ],
        },
      ],
    ]);
  });

  it("records the versions of a new database in statements of at most 33 rows, the hundred parameters a Durable Object binds", async () => {
    const { database, batches, versions } = memoryDatabase({ batching: true });
    await migrate(database, [scopeOf("a", 40), scopeOf("b", 30)]);
    const inserts = (batches[0] ?? []).filter(({ sql }) => sql.startsWith("INSERT"));
    expect(inserts.map(({ params }) => params.length)).toEqual([99, 99, 12]);
    expect(versions()).toHaveLength(70);
  });

  it("records a number of versions that fills its statements exactly with no empty statement after them", async () => {
    const { database, batches, versions } = memoryDatabase({ batching: true });
    await migrate(database, [scopeOf("a", 40), scopeOf("b", 26)]);
    const inserts = (batches[0] ?? []).filter(({ sql }) => sql.startsWith("INSERT"));
    expect(inserts.map(({ params }) => params.length)).toEqual([99, 99]);
    expect(versions()).toHaveLength(66);
  });

  it("numbers the parameters of every recorded version from 1 in each statement, on a dialect that numbers them", async () => {
    const { database, versions } = memoryDatabase({ batching: true });
    await migrate(database, [scopeOf("a", 35)], {
      dialect: { ...sqliteDialect, placeholder: (index) => `?${index}` },
    });
    expect(versions()).toEqual(
      Array.from({ length: 35 }, (_, index) => ({
        scope: "a",
        version: index + 1,
        applied_at: "2026-11-08T10:00:00.000Z",
      })),
    );
  });

  it("reads the tables and nothing else under the lock of a database that has no versions yet", async () => {
    const { database, statements } = memoryDatabase();
    await migrate(database, [scopeOf("a", 1)]);
    expect(statements.slice(0, 2)).toEqual([
      `SELECT "scope", max("version") AS "version" FROM ${table} GROUP BY "scope"`,
      `SELECT "name" FROM sqlite_master WHERE "type" = 'table'`,
    ]);
  });

  it("creates a scope new to a database whose other scopes it already holds, reading their versions under the lock", async () => {
    const { database, versions, statements } = memoryDatabase();
    const applied: string[] = [];
    await migrate(database, [scopeOf("a", 2)]);
    statements.length = 0;
    await migrate(database, [scopeOf("a", 2), scopeOf("b", 1, { applied })]);
    expect(applied).toEqual([]);
    expect(statements).toContain(
      `SELECT "scope", max("version") AS "version" FROM ${table} GROUP BY "scope"`,
    );
    expect(versions()).toEqual(recorded);
  });

  it("replays a scope whose tables a database already holds without a version, as one an earlier version created", async () => {
    const { db, database, versions } = memoryDatabase();
    db.exec('CREATE TABLE "a2" ("id" TEXT)');
    const applied: string[] = [];
    await migrate(database, [scopeOf("a", 2, { applied }), scopeOf("b", 1, { applied })]);
    expect(applied).toEqual(["a1", "a2"]);
    expect(versions()).toEqual(recorded);
  });

  it("keeps the scopes in order, so one that fails as it is replayed leaves a new one after it uncreated", async () => {
    const { db, database, tables } = memoryDatabase();
    db.exec('CREATE TABLE "a1" ("id" TEXT)');
    const failing: SchemaScope = {
      ...scopeOf("a", 1),
      migrations: [
        {
          version: 1,
          migrate: async () => {
            throw new Error("refused");
          },
        },
      ],
    };
    await expect(migrate(database, [failing, scopeOf("b", 1)])).rejects.toThrow("refused");
    expect(tables()).toEqual(["a1"]);
  });

  it("creates in one pass the new scopes that follow one it replays", async () => {
    const { db, database, versions, locks } = memoryDatabase();
    db.exec('CREATE TABLE "a1" ("id" TEXT)');
    const applied: string[] = [];
    await migrate(database, [
      scopeOf("a", 2, { applied }),
      scopeOf("b", 1, { applied }),
      scopeOf("c", 1, { applied }),
    ]);
    expect(applied).toEqual(["a1", "a2"]);
    expect(locks()).toBe(3);
    expect(versions().map(({ scope, version }) => `${scope}${version}`)).toEqual([
      "a1",
      "a2",
      "b1",
      "c1",
    ]);
  });

  it("replays the migrations a versioned scope lacks, without taking a lock to look for new ones", async () => {
    const { database, locks } = memoryDatabase();
    await migrate(database, [scopeOf("a", 1)]);
    const applied: string[] = [];
    const before = locks();
    await migrate(database, [scopeOf("a", 3, { applied })]);
    expect(applied).toEqual(["a2", "a3"]);
    expect(locks() - before).toBe(1);
  });

  it("replays a scope another instance versioned while it waited for the lock", async () => {
    const { db, database, versions } = memoryDatabase();
    const applied: string[] = [];
    await migrate(database, [scopeOf("a", 2, { applied })], {
      locked: (work) =>
        database.write(async (tx) => {
          db.exec(
            `CREATE TABLE IF NOT EXISTS ${table} ("scope" TEXT, "version" INTEGER, "applied_at" TEXT, PRIMARY KEY ("scope", "version"))`,
          );
          db.exec(`INSERT OR IGNORE INTO ${table} VALUES ('a', 1, 'meanwhile')`);
          return work(tx);
        }),
    });
    expect(applied).toEqual(["a2"]);
    expect(versions().map(({ version }) => version)).toEqual([1, 2]);
  });

  it("creates a new database once when instances start together", async () => {
    const { database, versions, tables } = memoryDatabase();
    await Promise.all([1, 2, 3].map(() => migrate(database, [scopeOf("a", 2), scopeOf("b", 1)])));
    expect(tables()).toEqual(["a1", "a2", "app_migrations", "b1"]);
    expect(versions()).toEqual(recorded);
  });

  it("refuses when a newer version created the scope while it waited for the lock, creating nothing", async () => {
    const { db, database, tables } = memoryDatabase();
    const refused = migrate(database, [scopeOf("a", 1)], {
      locked: (work) =>
        database.write(async (tx) => {
          db.exec(
            `CREATE TABLE IF NOT EXISTS ${table} ("scope" TEXT, "version" INTEGER, "applied_at" TEXT)`,
          );
          db.exec(`INSERT INTO ${table} VALUES ('a', 2, 'meanwhile')`);
          return work(tx);
        }),
    });
    await expect(refused).rejects.toMatchObject({ scope: "a", version: 2, supported: 1 });
    expect(tables()).toEqual([]);
  });

  it("leaves nothing of a new database whose creation fails, and creates it whole next time", async () => {
    const { database, versions, tables } = memoryDatabase();
    const broken: SchemaScope = {
      ...scopeOf("a", 2),
      latest: { tables: ['"a1"', '"a2"'], statements: ['CREATE TABLE "a1" ("id" TEXT)', "BOOM"] },
    };
    await expect(migrate(database, [broken])).rejects.toThrow();
    expect(tables()).toEqual([]);
    await migrate(database, [scopeOf("a", 2)]);
    expect(versions().map(({ version }) => version)).toEqual([1, 2]);
  });

  it("refuses a scope a newer version migrated before it locks anything", async () => {
    const { db, database, locks } = memoryDatabase();
    await migrate(database, [scopeOf("a", 1)]);
    db.exec(`INSERT INTO ${table} VALUES ('a', 7, 'later')`);
    const before = locks();
    await expect(migrate(database, [scopeOf("b", 1), scopeOf("a", 1)])).rejects.toMatchObject({
      scope: "a",
      version: 7,
    });
    expect(locks()).toBe(before);
  });
});
