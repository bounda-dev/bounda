import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigurationError, StorageSchemaTooNewError } from "../../contracts/errors.ts";
import {
  type NodeSqliteAdapter,
  createNodeSqliteAdapter as openNodeSqlite,
} from "./node-sqlite.ts";

let directory: string;
let files = 0;
const opened: NodeSqliteAdapter[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bounda-restore-copy-"));
});

afterAll(async () => {
  for (const { db } of opened.splice(0)) db.close();
  await rm(directory, { recursive: true, force: true });
});

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
    CREATE TABLE tags (name TEXT PRIMARY KEY, count INTEGER) WITHOUT ROWID;
    CREATE INDEX notes_text ON notes (text);
    CREATE TABLE log (text TEXT);
    CREATE TRIGGER notes_logged AFTER INSERT ON notes BEGIN INSERT INTO log VALUES (new.text); END;
  `);
  const note = sqlite.db.prepare("INSERT INTO notes (text, data) VALUES (?, ?)");
  const tag = sqlite.db.prepare("INSERT INTO tags (name, count) VALUES (?, ?)");
  for (let index = 0; index < rows; index += 1) {
    note.run(`note ${index}`, new Uint8Array([index % 256, 7]));
    tag.run(`tag ${index}`, Number.MAX_SAFE_INTEGER - index);
  }
  // Removed rows leave the counter past the last id, as the copy's must come back.
  sqlite.db.exec(`DELETE FROM notes WHERE id > ${rows - 3}`);
  return sqlite;
};

describe("restoring a copy of a SQLite database in place", () => {
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
});
