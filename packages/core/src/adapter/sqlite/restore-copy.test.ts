import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigurationError, StorageSchemaTooNewError } from "../../contracts/errors.ts";
import { ON_DISK_TIMEOUT_MS } from "../../kernel/test-support.ts";
import type { SqlDatabase } from "../sql/database.ts";
import { createSqliteAdapter } from "./adapter.ts";
import {
  type NodeSqliteAdapter,
  createNodeSqliteAdapter as openNodeSqlite,
} from "./node-sqlite.ts";
import { restoreSqliteCopy } from "./restore-copy.ts";

let directory: string;
let files = 0;
const opened: NodeSqliteAdapter[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bounda-restore-copy-"));
});

afterAll(async () => {
  for (const { db } of opened.splice(0)) db.close();
  await rm(directory, { recursive: true, force: true });
}, ON_DISK_TIMEOUT_MS);

const fresh = (name: string): string => {
  files += 1;
  return join(directory, `${name}-${files}.db`);
};

const open = (path: string): NodeSqliteAdapter => {
  const sqlite = openNodeSqlite(path);
  opened.push(sqlite);
  return sqlite;
};

const rowsOf = (db: DatabaseSync, sql: string): unknown[] => db.prepare(sql).all();

// The connection as the adapter's own: one write transaction at a time.
const databaseOf = (db: DatabaseSync): SqlDatabase => {
  const executor = {
    run: async (sql: string, params: readonly unknown[]) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async (sql: string, params: readonly unknown[]) =>
      db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
  };
  return {
    ...executor,
    write: async (work) => {
      db.exec("BEGIN IMMEDIATE");
      const result = await work({ ...executor, raw: db });
      db.exec("COMMIT");
      return result;
    },
  };
};

const schemaOf = (db: DatabaseSync): unknown[] =>
  rowsOf(
    db,
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
  );

// A database with Bounda's tables, migrated, a counter, rows past a page in a table with a rowid
// and in one without, and an index and a trigger of the app's own.
const seeded = async (path: string, rows: number): Promise<NodeSqliteAdapter> => {
  const sqlite = open(path);
  await sqlite.adapter.migrate(["storage", "checkpoints"]);
  sqlite.db.exec(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, data BLOB);
    CREATE TABLE tags (name TEXT PRIMARY KEY, count INTEGER)
      WITHOUT   ROWID;
    CREATE INDEX notes_text ON notes (text);
    CREATE TABLE log (text TEXT);
    CREATE TRIGGER notes_logged AFTER INSERT ON notes BEGIN INSERT INTO log VALUES (new.text); END;
  `);
  const note = sqlite.db.prepare("INSERT INTO notes (text, data) VALUES (?, ?)");
  const tag = sqlite.db.prepare("INSERT INTO tags (name, count) VALUES (?, ?)");
  // In one transaction: a commit per row waits on the disk, longest on Windows.
  sqlite.db.exec("BEGIN");
  for (let index = 0; index < rows; index += 1) {
    note.run(`note ${index}`, new Uint8Array([index % 256, 7]));
    tag.run(`tag ${index}`, Number.MAX_SAFE_INTEGER - index);
  }
  sqlite.db.exec("COMMIT");
  // Removed rows leave the counter past the last id, as the copy's must come back.
  sqlite.db.exec(`DELETE FROM notes WHERE id > ${rows - 3}`);
  return sqlite;
};

describe("restoring a copy of a SQLite database in place", { timeout: ON_DISK_TIMEOUT_MS }, () => {
  it("puts back every table, row, counter, index and trigger the copy holds, and nothing else", async () => {
    const copy = fresh("copy");
    const source = await seeded(copy, 1_203);
    const live = await seeded(fresh("live"), 10);
    live.db.exec("CREATE TABLE stray (x); CREATE VIEW strays AS SELECT * FROM stray;");
    await live.adapter.restore?.({ copy });
    expect(schemaOf(live.db)).toEqual(schemaOf(source.db));
    for (const sql of [
      "SELECT * FROM notes ORDER BY id",
      "SELECT * FROM tags ORDER BY name",
      "SELECT * FROM log ORDER BY rowid",
      "SELECT * FROM sqlite_sequence ORDER BY name",
    ]) {
      expect(rowsOf(live.db, sql)).toEqual(rowsOf(source.db, sql));
    }
    expect(rowsOf(live.db, "SELECT count(*) AS n FROM notes")).toEqual([{ n: 1_200 }]);
    // The trigger ran for the copy's rows once, in the copy, and runs again from now on.
    live.db.exec("INSERT INTO notes (text) VALUES ('after')");
    expect(rowsOf(live.db, "SELECT max(id) AS id FROM notes")).toEqual([{ id: 1_204 }]);
    expect(rowsOf(live.db, "SELECT count(*) AS n FROM log")).toEqual([{ n: 1_204 }]);
  });

  it("takes a copy bound to a tenant into a database bound to none, and one bound to none into a tenant's", async () => {
    const bind = (sqlite: NodeSqliteAdapter, tenant: string): void => {
      sqlite.db.exec(
        `INSERT INTO bounda_tenancy ("scope", "tenant", "store", "bound_at") VALUES ('database', '${tenant}', 'store', '2026-11-18T00:00:00.000Z')`,
      );
    };
    const bound = fresh("bound");
    bind(await seeded(bound, 2), "acme");
    const unbound = fresh("unbound");
    await seeded(unbound, 5);
    const live = await seeded(fresh("live"), 1);
    await live.adapter.restore?.({ copy: bound });
    expect(rowsOf(live.db, 'SELECT "tenant" FROM bounda_tenancy')).toEqual([{ tenant: "acme" }]);
    await live.adapter.restore?.({ copy: unbound });
    expect(rowsOf(live.db, 'SELECT "tenant" FROM bounda_tenancy')).toEqual([]);
    expect(rowsOf(live.db, "SELECT count(*) AS n FROM notes")).toEqual([{ n: 2 }]);
  });

  it("keeps the fence the database holds, whatever the copy's, and refuses a frozen database, changing nothing", async () => {
    const fence = (db: DatabaseSync) =>
      rowsOf(db, 'SELECT "tenant", "state", "since" FROM bounda_tenant_fence');
    const since = "2026-03-01T00:00:00.000Z";
    const frozenCopy = fresh("frozen-copy");
    (await seeded(frozenCopy, 5)).db.exec(
      `INSERT INTO bounda_tenant_fence VALUES ('app', 'acme', 'frozen', '${since}')`,
    );
    const live = await seeded(fresh("live"), 1);
    await live.adapter.restore?.({ copy: frozenCopy });
    expect(fence(live.db)).toEqual([]);
    expect(rowsOf(live.db, "SELECT count(*) AS n FROM notes")).toEqual([{ n: 2 }]);
    const forgotten = await seeded(fresh("forgotten"), 1);
    forgotten.db.exec(
      `INSERT INTO bounda_tenant_fence VALUES ('app', 'acme', 'forgotten', '${since}')`,
    );
    const open = fresh("open-copy");
    await seeded(open, 6);
    await forgotten.adapter.restore?.({ copy: open });
    expect(fence(forgotten.db)).toEqual([{ tenant: "acme", state: "forgotten", since }]);
    expect(rowsOf(forgotten.db, "SELECT count(*) AS n FROM notes")).toEqual([{ n: 3 }]);
    const frozen = await seeded(fresh("frozen"), 4);
    frozen.db.exec(`INSERT INTO bounda_tenant_fence VALUES ('app', 'acme', 'frozen', '${since}')`);
    const before = schemaOf(frozen.db);
    await expect(frozen.adapter.restore?.({ copy: open })).rejects.toMatchObject({
      code: "TENANT_FROZEN",
      frozenAt: since,
    });
    expect(schemaOf(frozen.db)).toEqual(before);
    expect(rowsOf(frozen.db, "SELECT count(*) AS n FROM notes")).toEqual([{ n: 1 }]);
  });

  it("counts the restore past what the copy and the database held, for the first instance that finds it to take", async () => {
    const counters = (db: DatabaseSync) =>
      rowsOf(
        db,
        `SELECT subscriber, position FROM bounda_checkpoints WHERE subscriber LIKE 'runtime:%' ORDER BY subscriber`,
      );
    const set = (db: DatabaseSync, restores: number, generation: number) =>
      db.exec(
        `INSERT OR REPLACE INTO bounda_checkpoints (subscriber, position) VALUES ('runtime:restores', ${restores}), ('runtime:generation', ${generation})`,
      );
    for (const [copied, live, restores, generation] of [
      [[5, 2], [1, 9], 6, 10],
      [[1, 9], [5, 2], 6, 10],
    ] as const) {
      const copy = fresh("copy");
      set((await seeded(copy, 1)).db, copied[0], copied[1]);
      const target = await seeded(fresh("live"), 1);
      set(target.db, live[0], live[1]);
      await target.adapter.restore?.({ copy });
      expect(counters(target.db)).toEqual([
        { subscriber: "runtime:generation", position: generation },
        { subscriber: "runtime:restore-unclaimed", position: restores },
        { subscriber: "runtime:restores", position: restores },
      ]);
    }
    // A database whose checkpoints were never migrated counts nothing.
    const bare = open(fresh("bare"));
    bare.db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
    const copy = fresh("copy");
    open(copy).db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
    await bare.adapter.restore?.({ copy });
    expect(rowsOf(bare.db, "SELECT name FROM sqlite_master WHERE name LIKE 'bounda_%'")).toEqual(
      [],
    );
  });

  it("brings a copy taken before a migration to the versions the database held", async () => {
    const copy = fresh("copy");
    const source = open(copy);
    await source.adapter.migrate(["checkpoints"]);
    const live = open(fresh("live"));
    await live.adapter.migrate(["storage", "checkpoints"]);
    const held = await live.adapter.schemaVersions();
    await live.adapter.restore?.({ copy });
    expect(await live.adapter.schemaVersions()).toEqual(held);
  });

  it("refuses a copy a newer version migrated, a copy of another tenant's, and none at all, changing nothing", async () => {
    const live = await seeded(fresh("live"), 5);
    const before = rowsOf(live.db, "SELECT * FROM notes ORDER BY id");
    const newer = await seeded(fresh("newer"), 1);
    newer.db.exec(
      `INSERT INTO bounda_migrations ("scope", "version", "applied_at") VALUES ('storage', 999, '2026-11-18T00:00:00.000Z')`,
    );
    await expect(live.adapter.restore?.({ copy: newer.db.location() ?? "" })).rejects.toThrow(
      StorageSchemaTooNewError,
    );
    const tenancy = (sqlite: NodeSqliteAdapter, tenant: string): void => {
      sqlite.db.exec(
        `INSERT INTO bounda_tenancy ("scope", "tenant", "store", "bound_at") VALUES ('database', '${tenant}', 'store', '2026-11-18T00:00:00.000Z')`,
      );
    };
    const other = await seeded(fresh("other"), 1);
    tenancy(other, "acme");
    tenancy(live, "default");
    await expect(live.adapter.restore?.({ copy: other.db.location() ?? "" })).rejects.toThrow(
      "The copy is of tenant acme's database, and this one is tenant default's",
    );
    await expect(live.adapter.restore?.({ copy: fresh("missing") })).rejects.toThrow(
      ConfigurationError,
    );
    const garbage = fresh("garbage");
    writeFileSync(garbage, "not a database, as long as a page".repeat(200));
    await expect(live.adapter.restore?.({ copy: garbage })).rejects.toThrow(
      "does not open as a database",
    );
    expect(rowsOf(live.db, "SELECT * FROM notes ORDER BY id")).toEqual(before);
  });

  it("pages a table with a rowid by it, so a page costs the same however far in", async () => {
    const copy = fresh("copy");
    await seeded(copy, 1_203);
    const live = open(fresh("live"));
    const source = open(copy);
    const statements: string[] = [];
    await restoreSqliteCopy({
      copy: {
        all: async (sql, params) => {
          statements.push(sql);
          return source.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
        },
      },
      live: databaseOf(live.db),
      prefix: "bounda_",
      scopes: [],
    });
    const paged = statements.filter((sql) => sql.includes("LIMIT"));
    expect(paged.filter((sql) => sql.includes('FROM "notes"'))).toEqual([
      'SELECT rowid AS "bounda:rowid", * FROM "notes" ORDER BY rowid LIMIT ?',
      'SELECT rowid AS "bounda:rowid", * FROM "notes" WHERE rowid > ? ORDER BY rowid LIMIT ?',
      'SELECT rowid AS "bounda:rowid", * FROM "notes" WHERE rowid > ? ORDER BY rowid LIMIT ?',
      'SELECT rowid AS "bounda:rowid", * FROM "notes" WHERE rowid > ? ORDER BY rowid LIMIT ?',
    ]);
    expect(paged.filter((sql) => sql.includes('FROM "tags"'))).toEqual([
      'SELECT * FROM "tags" LIMIT ? OFFSET ?',
      'SELECT * FROM "tags" LIMIT ? OFFSET ?',
      'SELECT * FROM "tags" LIMIT ? OFFSET ?',
      'SELECT * FROM "tags" LIMIT ? OFFSET ?',
    ]);
  });

  it("is an adapter's only with a way to open a copy, which it closes whatever the restore does", async () => {
    const live = open(fresh("live"));
    await live.adapter.migrate(["storage"]);
    const connection = () => ({ db: databaseOf(live.db), raw: live.db });
    const without = createSqliteAdapter({
      name: "plain",
      options: {},
      tablePrefix: "bounda_",
      acquire: connection,
      release: async () => {},
    });
    expect(without.restore).toBeUndefined();
    let closed = 0;
    const source = open(fresh("copy"));
    await source.adapter.migrate(["storage"]);
    const restoring = createSqliteAdapter({
      name: "restoring",
      options: {},
      tablePrefix: "bounda_",
      acquire: connection,
      release: async () => {},
      openCopy: async () => ({
        db: { all: async (sql, params) => databaseOf(source.db).all(sql, params) },
        close: async () => {
          closed += 1;
        },
      }),
    });
    await restoring.restore?.({ copy: "copy" });
    expect(closed).toBe(1);
    source.db.exec(
      `INSERT INTO bounda_tenancy ("scope", "tenant", "store", "bound_at") VALUES ('database', 'acme', 'store', '2026-11-18T00:00:00.000Z')`,
    );
    live.db.exec(
      `INSERT INTO bounda_tenancy ("scope", "tenant", "store", "bound_at") VALUES ('database', 'default', 'store', '2026-11-18T00:00:00.000Z')`,
    );
    await expect(restoring.restore?.({ copy: "copy" })).rejects.toThrow(ConfigurationError);
    expect(closed).toBe(2);
  });
});
