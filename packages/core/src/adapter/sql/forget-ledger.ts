import type {
  ForgetLedger,
  ForgetLedgerEntry,
  LedgerRedaction,
  LedgerRestriction,
} from "../storage/forget-ledger.ts";
import type { SqlDialect } from "./dialect.ts";
import { quoteIdentifier } from "./identifiers.ts";
import type { SqlExecutor } from "./sql-table.ts";

const COLUMNS = [
  "tenant",
  "event_id",
  "person",
  "forgotten_at",
  "reason",
  "fingerprints",
  "categories",
  "restriction",
  "redaction",
] as const;
// Within the hundred parameters a Durable Object's SQLite binds to one statement.
const ENTRIES_PER_INSERT = Math.floor(100 / COLUMNS.length);

export interface ForgetLedgerStatementsFunction {
  (table: string, dialect: Pick<SqlDialect, "name">): readonly string[];
}

/**
 * The ledger's table as its first version created it, `table` already quoted. PostgreSQL compares
 * the ordering columns by code unit, as SQLite does, rather than by the database's collation.
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

export interface ForgetLedgerMarksTableForFunction {
  (table: string): string;
}

/**
 * The table of the ledger's marks, beside the ledger's own `table`, both quoted.
 */
export const forgetLedgerMarksTableFor: ForgetLedgerMarksTableForFunction = (table) =>
  quoteIdentifier(`${table.slice(1, -1)}_marks`);

export interface ForgetLedgerMarksStatementFunction {
  (table: string): string;
}

/**
 * The table of the ledger's marks, one row per tenant and name, beside the ledger's own `table`,
 * quoted: the second migration of the ledger's scope.
 */
export const forgetLedgerMarksStatement: ForgetLedgerMarksStatementFunction = (table) =>
  `CREATE TABLE IF NOT EXISTS ${forgetLedgerMarksTableFor(table)} (
    "tenant" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    PRIMARY KEY ("tenant", "name")
  )`;

export interface ForgetLedgerReasonStatementsFunction {
  (table: string): readonly string[];
}

/**
 * The third version: each entry keeps its reason and the keys it names. An entry written before
 * reads as a request that names none, which any key matches.
 */
export const forgetLedgerReasonStatements: ForgetLedgerReasonStatementsFunction = (table) => [
  `ALTER TABLE ${table} ADD COLUMN "reason" TEXT NOT NULL DEFAULT 'requested'`,
  `ALTER TABLE ${table} ADD COLUMN "fingerprints" TEXT`,
];

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
 * The fourth version: the categories each forgetting was asked for, as a JSON array, `NULL` for
 * the person as a whole, which every entry written before was. SQLite has no `IF NOT EXISTS`
 * there, so its caller runs it only on a table without the column.
 */
export const forgetLedgerCategoriesStatement: ForgetLedgerCategoriesStatementFunction = (
  table,
  { name },
) =>
  `ALTER TABLE ${table} ADD COLUMN ${name === "postgresql" ? "IF NOT EXISTS " : ""}"categories" TEXT`;

export interface ForgetLedgerRestrictionStatementFunction {
  (table: string, dialect: Pick<SqlDialect, "name">): string;
}

/**
 * The fifth version: the change of restrictions an entry records instead of a forgetting, as
 * JSON, `NULL` for a forgetting, which every entry written before was. SQLite has no
 * `IF NOT EXISTS` there, so its caller runs it only on a table without the column.
 */
export const forgetLedgerRestrictionStatement: ForgetLedgerRestrictionStatementFunction = (
  table,
  { name },
) =>
  `ALTER TABLE ${table} ADD COLUMN ${name === "postgresql" ? "IF NOT EXISTS " : ""}"restriction" TEXT`;

export interface ForgetLedgerRedactionStatementFunction {
  (table: string, dialect: Pick<SqlDialect, "name">): string;
}

/**
 * The sixth version: the redaction an entry records instead of a forgetting, as JSON, `NULL` for
 * anything else, which every entry written before was. SQLite has no `IF NOT EXISTS` there, so
 * its caller runs it only on a table without the column.
 */
export const forgetLedgerRedactionStatement: ForgetLedgerRedactionStatementFunction = (
  table,
  { name },
) =>
  `ALTER TABLE ${table} ADD COLUMN ${name === "postgresql" ? "IF NOT EXISTS " : ""}"redaction" TEXT`;

const entryOf = (row: Record<string, unknown>): ForgetLedgerEntry => {
  const categories: unknown = JSON.parse(String(row.categories ?? null));
  const entry: ForgetLedgerEntry = {
    personId: String(row.person),
    categories: Array.isArray(categories) ? categories.map(String) : null,
    eventId: String(row.event_id),
    forgottenAt: String(row.forgotten_at),
    reason: row.reason === "retention" ? "retention" : "requested",
  };
  const fingerprints: unknown = JSON.parse(String(row.fingerprints ?? null));
  const restriction = JSON.parse(String(row.restriction ?? null)) as LedgerRestriction | null;
  const redaction = JSON.parse(String(row.redaction ?? null)) as LedgerRedaction | null;
  return {
    ...entry,
    ...(Array.isArray(fingerprints) ? { fingerprints: fingerprints.map(String) } : {}),
    ...(restriction === null ? {} : { restriction }),
    ...(redaction === null ? {} : { redaction }),
  };
};

const SELECTED = `"event_id", "person", "forgotten_at", "reason", "fingerprints", "categories", "restriction", "redaction"`;

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
  const marks = forgetLedgerMarksTableFor(table);
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
          (_, row) =>
            `(${COLUMNS.map((_, column) => p(row * COLUMNS.length + column + 1)).join(", ")})`,
        );
        await db.run(
          `INSERT INTO ${table} (${COLUMNS.map((column) => `"${column}"`).join(", ")}) VALUES ${rows.join(", ")} ON CONFLICT ("tenant", "event_id") DO NOTHING`,
          chunk.flatMap(
            ({
              eventId,
              personId,
              forgottenAt,
              reason,
              fingerprints,
              categories,
              restriction,
              redaction,
            }) => [
              tenant,
              eventId,
              personId,
              forgottenAt,
              reason,
              fingerprints === undefined ? null : JSON.stringify(fingerprints),
              categories === null ? null : JSON.stringify(categories),
              restriction === undefined ? null : JSON.stringify(restriction),
              redaction === undefined ? null : JSON.stringify(redaction),
            ],
          ),
        );
      }
    },
    read: async ({ after, limit }) => {
      await prepared();
      const rows =
        after === undefined
          ? await db.all(
              `SELECT ${SELECTED} FROM ${table} WHERE "tenant" = ${p(1)} ORDER BY "forgotten_at", "event_id" LIMIT ${p(2)}`,
              [tenant, limit],
            )
          : await db.all(
              `SELECT ${SELECTED} FROM ${table} WHERE "tenant" = ${p(1)} AND ("forgotten_at", "event_id") > (${p(2)}, ${p(3)}) ORDER BY "forgotten_at", "event_id" LIMIT ${p(4)}`,
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
    readMark: async (name) => {
      await prepared();
      const [row] = await db.all(
        `SELECT "value" FROM ${marks} WHERE "tenant" = ${p(1)} AND "name" = ${p(2)}`,
        [tenant, name],
      );
      return Number(row?.value ?? 0);
    },
    raiseMark: async (name, value) => {
      await prepared();
      await db.run(
        `INSERT INTO ${marks} ("tenant", "name", "value") VALUES (${p(1)}, ${p(2)}, ${p(3)}) ON CONFLICT ("tenant", "name") DO UPDATE SET "value" = EXCLUDED."value" WHERE ${marks}."value" < EXCLUDED."value"`,
        [tenant, name, value],
      );
    },
    close,
  };
};
