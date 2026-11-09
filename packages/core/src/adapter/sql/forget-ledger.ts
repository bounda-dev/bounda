import type { ForgetLedger, ForgetLedgerEntry } from "../storage/forget-ledger.ts";
import type { SqlDialect } from "./dialect.ts";
import { quoteIdentifier } from "./identifiers.ts";
import type { SqlExecutor } from "./sql-table.ts";

const COLUMNS = ["tenant", "event_id", "person", "forgotten_at", "reason", "fingerprints"] as const;
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

export interface ForgetLedgerReasonStatementsFunction {
  (table: string): readonly string[];
}

/**
 * The second version: each entry keeps its reason and the keys it names. An entry written before
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

const entryOf = (row: Record<string, unknown>): ForgetLedgerEntry => {
  const entry: ForgetLedgerEntry = {
    personId: String(row.person),
    eventId: String(row.event_id),
    forgottenAt: String(row.forgotten_at),
    reason: row.reason === "retention" ? "retention" : "requested",
  };
  const fingerprints: unknown =
    typeof row.fingerprints === "string" ? JSON.parse(row.fingerprints) : null;
  return Array.isArray(fingerprints) ? { ...entry, fingerprints: fingerprints.map(String) } : entry;
};

const SELECTED = `"event_id", "person", "forgotten_at", "reason", "fingerprints"`;

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
          (_, row) =>
            `(${COLUMNS.map((_, column) => p(row * COLUMNS.length + column + 1)).join(", ")})`,
        );
        await db.run(
          `INSERT INTO ${table} (${COLUMNS.map((column) => `"${column}"`).join(", ")}) VALUES ${rows.join(", ")} ON CONFLICT ("tenant", "event_id") DO NOTHING`,
          chunk.flatMap(({ eventId, personId, forgottenAt, reason, fingerprints }) => [
            tenant,
            eventId,
            personId,
            forgottenAt,
            reason,
            fingerprints === undefined ? null : JSON.stringify(fingerprints),
          ]),
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
    close,
  };
};
