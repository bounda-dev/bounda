import { ConfigurationError } from "../../contracts/errors.ts";
import {
  RESTORE_GENERATION,
  RESTORE_TAKEN_BY_FIRST,
  RESTORES_FOUND,
} from "../../kernel/shared/restores.ts";
import { createSqlCheckpointStore } from "../sql/checkpoint-store.ts";
import type { SqlDatabase, SqlTransaction } from "../sql/database.ts";
import { sqliteDialect } from "../sql/dialect.ts";
import { quoteIdentifier, storageTableNameFor } from "../sql/identifiers.ts";
import { quoteName } from "../sql/inspection.ts";
import type { SchemaScope } from "../sql/migrations.ts";
import { readSchemaVersions, schemaMigrationsTableFor } from "../sql/migrations.ts";
import type { SqlExecutor } from "../sql/sql-table.ts";
import { isMissingSqliteTable, migrateSqlite } from "./migrations.ts";
import { storageTablesFor } from "./schema.ts";

/**
 * A copy of a SQLite database, open for reading: nothing else writes it while it is restored.
 */
export interface SqliteCopy {
  readonly db: Pick<SqlExecutor, "all">;
  close(): Promise<void>;
}

export interface RestoreSqliteCopyArgs {
  readonly copy: Pick<SqlExecutor, "all">;
  readonly live: SqlDatabase;
  readonly prefix: string;
  /**
   * Every scope of Bounda's tables the adapter migrates.
   */
  readonly scopes: readonly SchemaScope[];
}

export interface RestoreSqliteCopyFunction {
  (args: RestoreSqliteCopyArgs): Promise<void>;
}

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

// Every object but SQLite's own, whose statements are all its sql holds; the counters of
// AUTOINCREMENT tables are rows to copy.
const SCHEMA_QUERY =
  'SELECT "type", "name", "sql" FROM sqlite_master WHERE "name" NOT LIKE \'sqlite_%\' ORDER BY rowid';
const SEQUENCE = "sqlite_sequence";
const PAGE_ROWS = 500;

const schemaOf = async (db: Pick<SqlExecutor, "all">): Promise<readonly SchemaObject[]> =>
  (await db.all(SCHEMA_QUERY, [])).map(({ type, name, sql }) => ({
    type: String(type),
    name: String(name),
    sql: String(sql),
  }));

const hasTable = async (db: Pick<SqlExecutor, "all">, name: string): Promise<boolean> =>
  (await db.all('SELECT 1 FROM sqlite_master WHERE "type" = \'table\' AND "name" = ?', [name]))
    .length > 0;

const tenantOf = async (db: Pick<SqlExecutor, "all">, prefix: string): Promise<string | null> => {
  const table = storageTableNameFor({ prefix, table: "tenancy" });
  if (!(await hasTable(db, table))) return null;
  const [row] = await db.all(`SELECT "tenant" FROM ${quoteIdentifier(table)}`, []);
  return row === undefined ? null : String(row.tenant);
};

// A table's rows in pages: by rowid where it has one, so a page costs the same however far in,
// under an alias no column takes.
async function* rowsOf(
  copy: Pick<SqlExecutor, "all">,
  table: SchemaObject,
): AsyncGenerator<readonly Record<string, unknown>[]> {
  const quoted = quoteName(table.name);
  if (/\bWITHOUT\s+ROWID\b/i.test(table.sql)) {
    for (let offset = 0; ; offset += PAGE_ROWS) {
      const page = await copy.all(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, [PAGE_ROWS, offset]);
      if (page.length === 0) return;
      yield page;
    }
  }
  const at = "bounda:rowid";
  const select = `SELECT rowid AS ${quoteName(at)}, * FROM ${quoted}`;
  let page = await copy.all(`${select} ORDER BY rowid LIMIT ?`, [PAGE_ROWS]);
  while (page.length > 0) {
    yield page.map(({ [at]: _rowid, ...row }) => row);
    const last = page[page.length - 1] as Record<string, unknown>;
    page = await copy.all(`${select} WHERE rowid > ? ORDER BY rowid LIMIT ?`, [
      last[at],
      PAGE_ROWS,
    ]);
  }
}

const insertRow = (
  tx: SqlTransaction,
  table: string,
  row: Readonly<Record<string, unknown>>,
): Promise<void> => {
  const columns = Object.keys(row);
  return tx.run(
    `INSERT INTO ${quoteName(table)} (${columns.map(quoteName).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((column) => row[column]),
  );
};

// The statements of an open transaction as a database, so the migrations run inside it.
const boundTo = (tx: SqlTransaction): SqlDatabase => ({
  run: tx.run,
  all: tx.all,
  write: (work) => work(tx),
});

/**
 * Replaces everything the live database holds with the copy's, in one write transaction on the
 * live database's connection: every table, index, trigger and view goes, and the copy's come back
 * with its rows, its Bounda tables brought to the versions the live database held. A copy of
 * another tenant's database is refused before anything is written.
 */
export const restoreSqliteCopy: RestoreSqliteCopyFunction = ({ copy, live, prefix, scopes }) =>
  live.write(async (tx) => {
    const [liveTenant, copyTenant] = await Promise.all([
      tenantOf(tx, prefix),
      tenantOf(copy, prefix),
    ]);
    if (liveTenant !== null && copyTenant !== null && liveTenant !== copyTenant) {
      throw new ConfigurationError(
        `The copy is of tenant ${copyTenant}'s database, and this one is tenant ${liveTenant}'s: restore a copy of this database`,
      );
    }
    const held = (
      await readSchemaVersions({
        db: tx,
        table: schemaMigrationsTableFor(prefix),
        scopes,
        isMissingTable: isMissingSqliteTable,
      })
    ).filter(({ version }) => version > 0);
    const checkpoints = createSqlCheckpointStore({
      db: tx,
      table: storageTablesFor(prefix).checkpoints,
      dialect: sqliteDialect,
    });
    const counted = held.some(({ scope }) => scope === "checkpoints");
    const before = counted
      ? await Promise.all([checkpoints.get(RESTORES_FOUND), checkpoints.get(RESTORE_GENERATION)])
      : [0, 0];
    // A foreign key between two tables is checked once both hold the copy's rows.
    await tx.run("PRAGMA defer_foreign_keys = ON", []);
    const current = await schemaOf(tx);
    // A table takes its indexes and triggers with it.
    for (const type of ["view", "table"]) {
      for (const object of current.filter((candidate) => candidate.type === type)) {
        await tx.run(`DROP ${type} ${quoteName(object.name)}`, []);
      }
    }
    const copied = await schemaOf(copy);
    const tables = copied.filter(({ type }) => type === "table");
    for (const { sql } of tables) await tx.run(sql, []);
    for (const table of tables) {
      for await (const page of rowsOf(copy, table)) {
        for (const row of page) await insertRow(tx, table.name, row);
      }
    }
    if (await hasTable(copy, SEQUENCE)) {
      await tx.run(`DELETE FROM ${SEQUENCE}`, []);
      for (const row of await copy.all(`SELECT * FROM ${SEQUENCE}`, [])) {
        await insertRow(tx, SEQUENCE, row);
      }
    }
    // After the rows, so no trigger writes what the copy holds already.
    for (const { type, sql } of copied) if (type !== "table") await tx.run(sql, []);
    await migrateSqlite({
      db: boundTo(tx),
      prefix,
      scopes: scopes.filter(({ scope }) => held.some((version) => version.scope === scope)),
    });
    // Counted here, past what the copy and the database held, for the first instance that finds it
    // to take: a running one by the count it read, a stopped one when it starts, ledger or not.
    if (counted) {
      const restores = Math.max(before[0] ?? 0, await checkpoints.get(RESTORES_FOUND)) + 1;
      const generation = Math.max(before[1] ?? 0, await checkpoints.get(RESTORE_GENERATION)) + 1;
      await checkpoints.set(RESTORES_FOUND, restores);
      await checkpoints.set(RESTORE_GENERATION, generation);
      await checkpoints.set(RESTORE_TAKEN_BY_FIRST, restores);
    }
  });
