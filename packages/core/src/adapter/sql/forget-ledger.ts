import type { ForgetLedger, ForgetLedgerEntry } from "../storage/forget-ledger.ts";
import type { SqlDialect } from "./dialect.ts";
import { quoteIdentifier } from "./identifiers.ts";
import type { SqlExecutor } from "./sql-table.ts";

// Five parameters a row, within the hundred a Durable Object's SQLite binds to one statement.
const ENTRIES_PER_INSERT = 20;

export interface ForgetLedgerStatementsFunction {
  (table: string, dialect: Pick<SqlDialect, "name">): readonly string[];
}

/**
 * The ledger's table as the first migration of its scope created it, `table` already quoted.
 * PostgreSQL compares the ordering columns by code unit, as SQLite does, rather than by the
 * database's collation.
 */
export const forgetLedgerStatements: ForgetLedgerStatementsFunction = (table, { name }) => {
  const ordered = name === "postgresql" ? ` COLLATE "C"` : "";
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
    "tenant" TEXT NOT NULL,
    "event_id" TEXT${ordered} NOT NULL,
    "person" TEXT NOT NULL,
    "forgotten_at" TEXT${ordered} NOT NULL,
    PRIMARY KEY ("tenant", "event_id")
  )`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${table.slice(1, -1)}_order_idx`)} ON ${table} ("tenant", "forgotten_at", "event_id")`,
  ];
};

export interface CreateSqlForgetLedgerArgs {
  readonly db: SqlExecutor;
  /**
   * Already quoted.
   */
  readonly table: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
  readonly tenant: string | undefined;
  /**
   * Creates the table when missing; run before the first statement, and again after it fails.
   */
  readonly ensureSchema: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface CreateSqlForgetLedgerFunction {
  (args: CreateSqlForgetLedgerArgs): ForgetLedger;
}

export interface ForgetLedgerCategoriesStatementFunction {
  (table: string, dialect: Pick<SqlDialect, "name">): string;
}

/**
 * The second migration of the ledger's scope: the categories each forgetting was asked for, as a
 * JSON array, `NULL` for the person as a whole, which every entry written before was. SQLite has
 * no `IF NOT EXISTS` there, so its caller runs it only on a table without the column.
 */
export const forgetLedgerCategoriesStatement: ForgetLedgerCategoriesStatementFunction = (
  table,
  { name },
) =>
  `ALTER TABLE ${table} ADD COLUMN ${name === "postgresql" ? "IF NOT EXISTS " : ""}"categories" TEXT`;

const entryOf = (row: Record<string, unknown>): ForgetLedgerEntry => ({
  personId: String(row.person),
  categories:
    row.categories === null ? null : (JSON.parse(String(row.categories)) as readonly string[]),
  eventId: String(row.event_id),
  forgottenAt: String(row.forgotten_at),
});

/**
 * The forget ledger of SQLite and PostgreSQL alike, in a table of its own that holds every
 * tenant's entries, an app without a tenant's under the empty name.
 */
export const createSqlForgetLedger: CreateSqlForgetLedgerFunction = ({
  db,
  table,
  dialect,
  tenant = "",
  ensureSchema,
  close,
}) => {
  const p = dialect.placeholder;
  let ready: Promise<void> | undefined;
  const prepared = (): Promise<void> => {
    ready ??= ensureSchema().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };
  return {
    append: async (entries) => {
      await prepared();
      for (let start = 0; start < entries.length; start += ENTRIES_PER_INSERT) {
        const chunk = entries.slice(start, start + ENTRIES_PER_INSERT);
        const rows = chunk.map(
          (_, index) => `(${[1, 2, 3, 4, 5].map((column) => p(index * 5 + column)).join(", ")})`,
        );
        await db.run(
          `INSERT INTO ${table} ("tenant", "event_id", "person", "forgotten_at", "categories") VALUES ${rows.join(", ")} ON CONFLICT ("tenant", "event_id") DO NOTHING`,
          chunk.flatMap(({ eventId, personId, forgottenAt, categories }) => [
            tenant,
            eventId,
            personId,
            forgottenAt,
            categories === null ? null : JSON.stringify(categories),
          ]),
        );
      }
    },
    read: async ({ after, limit }) => {
      await prepared();
      const rows =
        after === undefined
          ? await db.all(
              `SELECT "event_id", "person", "forgotten_at", "categories" FROM ${table} WHERE "tenant" = ${p(1)} ORDER BY "forgotten_at", "event_id" LIMIT ${p(2)}`,
              [tenant, limit],
            )
          : await db.all(
              `SELECT "event_id", "person", "forgotten_at", "categories" FROM ${table} WHERE "tenant" = ${p(1)} AND ("forgotten_at", "event_id") > (${p(2)}, ${p(3)}) ORDER BY "forgotten_at", "event_id" LIMIT ${p(4)}`,
              [tenant, after.forgottenAt, after.eventId, limit],
            );
      return rows.map(entryOf);
    },
    prune: async ({ before }) => {
      await prepared();
      await db.run(`DELETE FROM ${table} WHERE "tenant" = ${p(1)} AND "forgotten_at" < ${p(2)}`, [
        tenant,
        before,
      ]);
    },
    close,
  };
};
