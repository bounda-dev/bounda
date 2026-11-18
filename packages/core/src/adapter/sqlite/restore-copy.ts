import { ConfigurationError } from "../../contracts/errors.ts";
import type { SqlDatabase, SqlTransaction } from "../sql/database.ts";
import { quoteIdentifier, storageTableNameFor } from "../sql/identifiers.ts";
import { quoteName } from "../sql/inspection.ts";
import type { SchemaScope } from "../sql/migrations.ts";
import { readSchemaVersions, schemaMigrationsTableFor } from "../sql/migrations.ts";
import type { SqlExecutor } from "../sql/sql-table.ts";
import { isMissingSqliteTable, migrateSqlite } from "./migrations.ts";

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
  readonly sql: string | null;
}

// SQLite's own objects, but for the counters of AUTOINCREMENT tables, which are rows to copy.
const SCHEMA_QUERY =
  'SELECT "type", "name", "sql" FROM sqlite_master WHERE "name" NOT LIKE \'sqlite_%\' ORDER BY rowid';
const SEQUENCE = "sqlite_sequence";
const PAGE_ROWS = 500;
// Below every build's limit on the parameters of one statement.
const MAX_PARAMETERS = 900;

const schemaOf = async (db: Pick<SqlExecutor, "all">): Promise<readonly SchemaObject[]> =>
  (await db.all(SCHEMA_QUERY, [])).map(({ type, name, sql }) => ({
    type: String(type),
    name: String(name),
    sql: sql === null ? null : String(sql),
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

// A table's rows in pages: by rowid where it has one, so a page costs the same however far in.
async function* rowsOf(
  copy: Pick<SqlExecutor, "all">,
  table: SchemaObject,
): AsyncGenerator<readonly Record<string, unknown>[]> {
  const quoted = quoteName(table.name);
  if (/\bWITHOUT\s+ROWID\b/i.test(table.sql ?? "")) {
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
    page = await copy.all(`${select} WHERE rowid > ? ORDER BY rowid LIMIT ?`, [
      page[page.length - 1]?.[at],
      PAGE_ROWS,
    ]);
  }
}

const insertRows = async (
  tx: SqlTransaction,
  table: string,
  rows: readonly Record<string, unknown>[],
): Promise<void> => {
  const [first] = rows;
  if (first === undefined) return;
  const columns = Object.keys(first);
  const perStatement = Math.max(1, Math.floor(MAX_PARAMETERS / Math.max(1, columns.length)));
  const into = `INSERT INTO ${quoteName(table)} (${columns.map(quoteName).join(", ")}) VALUES `;
  const tuple = `(${columns.map(() => "?").join(", ")})`;
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    await tx.run(
      `${into}${chunk.map(() => tuple).join(", ")}`,
      chunk.flatMap((row) => columns.map((column) => row[column] ?? null)),
    );
  }
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
    // A foreign key between two tables is checked once both hold the copy's rows.
    await tx.run("PRAGMA defer_foreign_keys = ON", []);
    const current = await schemaOf(tx);
    for (const type of ["view", "trigger", "table"]) {
      for (const object of current.filter((candidate) => candidate.type === type)) {
        await tx.run(`DROP ${type.toUpperCase()} IF EXISTS ${quoteName(object.name)}`, []);
      }
    }
    const copied = await schemaOf(copy);
    const tables = copied.filter(({ type }) => type === "table");
    for (const { sql } of tables) if (sql !== null) await tx.run(sql, []);
    for (const table of tables) {
      for await (const page of rowsOf(copy, table)) await insertRows(tx, table.name, page);
    }
    if (await hasTable(copy, SEQUENCE)) {
      await tx.run(`DELETE FROM ${SEQUENCE}`, []);
      await insertRows(tx, SEQUENCE, await copy.all(`SELECT * FROM ${SEQUENCE}`, []));
    }
    // After the rows, so no trigger writes what the copy holds already.
    for (const { type, sql } of copied) if (type !== "table" && sql !== null) await tx.run(sql, []);
    await migrateSqlite({
      db: boundTo(tx),
      prefix,
      scopes: scopes.filter(({ scope }) => held.some((version) => version.scope === scope)),
    });
  });
