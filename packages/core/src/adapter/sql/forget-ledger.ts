import { DEFAULT_TENANT } from "../../kernel/personal-data/tenant-keys.ts";
import {
  byCodeUnit,
  type ForgetLedger,
  type ForgetLedgerEntry,
  forgottenReasonOf,
  type LedgerDisclosure,
  type LedgerReached,
  type LedgerRedaction,
  type LedgerRestriction,
} from "../storage/forget-ledger.ts";
import type { SqlDatabase } from "./database.ts";
import type { SqlDialect } from "./dialect.ts";
import { quoteIdentifier } from "./identifiers.ts";
import type { LatestSchema } from "./migrations.ts";
import { createSqlTenantFence, tenantFenceTableStatement } from "./tenant-fence.ts";

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
  "disclosure",
  "committed",
  "reached",
] as const;
// Within the hundred parameters a Durable Object's SQLite binds to one statement.
const ENTRIES_PER_INSERT = Math.floor(100 / COLUMNS.length);

const orderIndexStatement = (table: string): string =>
  `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${table.slice(1, -1)}_order_idx`)} ON ${table} ("tenant", "forgotten_at", "event_id")`;

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
    orderIndexStatement(table),
  ];
};

export interface ForgetLedgerLatestSchemaFunction {
  (table: string, dialect: Pick<SqlDialect, "name">): LatestSchema;
}

/**
 * The ledger's tables beside its own `table`, quoted, as its last version leaves them.
 */
export const forgetLedgerLatestSchema: ForgetLedgerLatestSchemaFunction = (table, { name }) => {
  const ordered = name === "postgresql" ? ` COLLATE "C"` : "";
  return {
    tables: [table, forgetLedgerMarksTableFor(table), forgetLedgerFenceTableFor(table)],
    statements: [
      `CREATE TABLE IF NOT EXISTS ${table} (
    "tenant" TEXT NOT NULL,
    "event_id" TEXT${ordered} NOT NULL,
    "person" TEXT NOT NULL,
    "forgotten_at" TEXT${ordered} NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'requested',
    "fingerprints" TEXT,
    "categories" TEXT,
    "restriction" TEXT,
    "redaction" TEXT,
    "disclosure" TEXT,
    "committed" INTEGER NOT NULL DEFAULT 1,
    "reached" TEXT,
    PRIMARY KEY ("tenant", "event_id")
  )`,
      orderIndexStatement(table),
      forgetLedgerMarksStatement(table),
      forgetLedgerFenceStatement(table),
    ],
  };
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

export interface ForgetLedgerFenceTableForFunction {
  (table: string): string;
}

/**
 * The table of the ledger's fences, one row per tenant fenced, beside the ledger's own `table`,
 * both quoted.
 */
export const forgetLedgerFenceTableFor: ForgetLedgerFenceTableForFunction = (table) =>
  quoteIdentifier(`${table.slice(1, -1)}_fence`);

export interface ForgetLedgerFenceStatementFunction {
  (table: string): string;
}

/**
 * The eighth version: the table of the ledger's fences, beside the ledger's own `table`, quoted.
 */
export const forgetLedgerFenceStatement: ForgetLedgerFenceStatementFunction = (table) =>
  tenantFenceTableStatement(forgetLedgerFenceTableFor(table));

export interface ForgetLedgerDefaultTenantStatementsFunction {
  (table: string): readonly string[];
}

/**
 * The ninth version: what an app that names no tenant wrote under the empty name moves to
 * `DEFAULT_TENANT`, the id every other store keys it by. Where both hold a row, the entry and the
 * higher mark are kept once, and of two fences the forgotten one, or of the same state the earlier.
 */
export const forgetLedgerDefaultTenantStatements: ForgetLedgerDefaultTenantStatementsFunction = (
  table,
) => {
  const marks = forgetLedgerMarksTableFor(table);
  const fence = forgetLedgerFenceTableFor(table);
  const named = `'${DEFAULT_TENANT}'`;
  const legacyMark = `(SELECT "l"."value" FROM ${marks} AS "l" WHERE "l"."tenant" = '' AND "l"."name" = ${marks}."name")`;
  return [
    `DELETE FROM ${table} WHERE "tenant" = '' AND "event_id" IN (SELECT "event_id" FROM ${table} WHERE "tenant" = ${named})`,
    `UPDATE ${table} SET "tenant" = ${named} WHERE "tenant" = ''`,
    `UPDATE ${marks} SET "value" = ${legacyMark} WHERE "tenant" = ${named} AND "value" < ${legacyMark}`,
    `DELETE FROM ${marks} WHERE "tenant" = '' AND "name" IN (SELECT "name" FROM ${marks} WHERE "tenant" = ${named})`,
    `UPDATE ${marks} SET "tenant" = ${named} WHERE "tenant" = ''`,
    `DELETE FROM ${fence} WHERE "scope" = '' AND EXISTS (SELECT 1 FROM ${fence} AS "d" WHERE "d"."scope" = ${named} AND (CASE WHEN "d"."state" = ${fence}."state" THEN "d"."since" <= ${fence}."since" ELSE "d"."state" = 'forgotten' END))`,
    `DELETE FROM ${fence} WHERE "scope" = ${named} AND EXISTS (SELECT 1 FROM ${fence} AS "l" WHERE "l"."scope" = '')`,
    `UPDATE ${fence} SET "scope" = ${named}, "tenant" = ${named} WHERE "scope" = ''`,
  ];
};

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
  readonly db: SqlDatabase;
  /**
   * Already quoted.
   */
  readonly table: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
  readonly tenant: string;
  /**
   * The text hashed with the tenant into the advisory lock that puts the ledger's writes behind
   * its fence, for an engine whose transactions run side by side, as PostgreSQL's do.
   */
  readonly lockKey?: string;
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

export interface ForgetLedgerDisclosureStatementFunction {
  (table: string, dialect: Pick<SqlDialect, "name">): string;
}

/**
 * The seventh version: the disclosure an entry records instead of a forgetting, as JSON, `NULL`
 * for anything else, which every entry written before was. SQLite has no `IF NOT EXISTS` there,
 * so its caller runs it only on a table without the column.
 */
export const forgetLedgerDisclosureStatement: ForgetLedgerDisclosureStatementFunction = (
  table,
  { name },
) =>
  `ALTER TABLE ${table} ADD COLUMN ${name === "postgresql" ? "IF NOT EXISTS " : ""}"disclosure" TEXT`;

export interface ForgetLedgerCommittedStatementFunction {
  (table: string, dialect: Pick<SqlDialect, "name">): string;
}

/**
 * The tenth version: whether an entry is an intention whose commit the stream has not copied yet,
 * `0`, or committed, `1`, which every entry written before reads as: the stream copied each one
 * whose forgetting committed, and a start of the version that wrote it committed again, as a
 * restore, any intention whose commit never came. SQLite has no `IF NOT EXISTS` there, so its
 * caller runs it only on a table without the column.
 */
export const forgetLedgerCommittedStatement: ForgetLedgerCommittedStatementFunction = (
  table,
  { name },
) =>
  `ALTER TABLE ${table} ADD COLUMN ${name === "postgresql" ? "IF NOT EXISTS " : ""}"committed" INTEGER NOT NULL DEFAULT 1`;

export interface ForgetLedgerReachedStatementFunction {
  (table: string, dialect: Pick<SqlDialect, "name">): string;
}

/**
 * The eleventh version: where the database stood when an intention was written, as JSON, `NULL`
 * for an entry the stream wrote, which tells nothing, as every entry written before. SQLite has no
 * `IF NOT EXISTS` there, so its caller runs it only on a table without the column.
 */
export const forgetLedgerReachedStatement: ForgetLedgerReachedStatementFunction = (
  table,
  { name },
) =>
  `ALTER TABLE ${table} ADD COLUMN ${name === "postgresql" ? "IF NOT EXISTS " : ""}"reached" TEXT`;

// One entry per event, committed when any of its appends is: an upsert that meets one event twice
// in a statement fails on PostgreSQL.
const onePerEvent = (entries: readonly ForgetLedgerEntry[]): readonly ForgetLedgerEntry[] => {
  const byEvent = new Map<string, ForgetLedgerEntry>();
  for (const entry of entries) {
    const kept = byEvent.get(entry.eventId);
    if (kept === undefined) byEvent.set(entry.eventId, entry);
    else if (entry.committed !== false) {
      const { committed: _, ...committed } = kept;
      byEvent.set(entry.eventId, committed);
    }
  }
  return [...byEvent.values()];
};

const entryOf = (row: Record<string, unknown>): ForgetLedgerEntry => {
  const categories: unknown = JSON.parse(String(row.categories ?? null));
  const entry: ForgetLedgerEntry = {
    personId: String(row.person),
    categories: Array.isArray(categories) ? categories.map(String) : null,
    eventId: String(row.event_id),
    forgottenAt: String(row.forgotten_at),
    reason: forgottenReasonOf(row.reason),
  };
  const fingerprints: unknown = JSON.parse(String(row.fingerprints ?? null));
  const restriction = JSON.parse(String(row.restriction ?? null)) as LedgerRestriction | null;
  const redaction = JSON.parse(String(row.redaction ?? null)) as LedgerRedaction | null;
  const disclosure = JSON.parse(String(row.disclosure ?? null)) as LedgerDisclosure | null;
  const reached = JSON.parse(String(row.reached ?? null)) as LedgerReached | null;
  return {
    ...entry,
    ...(Array.isArray(fingerprints) ? { fingerprints: fingerprints.map(String) } : {}),
    ...(restriction === null ? {} : { restriction }),
    ...(redaction === null ? {} : { redaction }),
    ...(disclosure === null ? {} : { disclosure }),
    ...(Number(row.committed) === 0 ? { committed: false as const } : {}),
    ...(reached === null ? {} : { reached }),
  };
};

const SELECTED = `"event_id", "person", "forgotten_at", "reason", "fingerprints", "categories", "restriction", "redaction", "disclosure", "committed", "reached"`;

/**
 * The forget ledger of SQLite and PostgreSQL alike, in a table of its own that holds every
 * tenant's entries.
 */
export const createSqlForgetLedger: CreateSqlForgetLedgerFunction = ({
  db,
  table,
  dialect,
  tenant,
  lockKey,
  ensureSchema,
  close,
}) => {
  const p = dialect.placeholder;
  const marks = forgetLedgerMarksTableFor(table);
  const fence = createSqlTenantFence({
    table: forgetLedgerFenceTableFor(table),
    dialect,
    ...(lockKey === undefined ? {} : { lock: [lockKey, tenant] as const }),
    scope: tenant,
  });
  const fenced = fence.guard(db);
  const fenceStore = fence.store(db);
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
      const appended = onePerEvent(entries);
      await fenced.write(async (tx) => {
        for (let start = 0; start < appended.length; start += ENTRIES_PER_INSERT) {
          const chunk = appended.slice(start, start + ENTRIES_PER_INSERT);
          const rows = chunk.map(
            (_, row) =>
              `(${COLUMNS.map((_, column) => p(row * COLUMNS.length + column + 1)).join(", ")})`,
          );
          await tx.run(
            `INSERT INTO ${table} (${COLUMNS.map((column) => `"${column}"`).join(", ")}) VALUES ${rows.join(", ")} ON CONFLICT ("tenant", "event_id") DO UPDATE SET "committed" = 1 WHERE ${table}."committed" = 0 AND EXCLUDED."committed" = 1`,
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
                disclosure,
                committed,
                reached,
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
                disclosure === undefined ? null : JSON.stringify(disclosure),
                committed === false ? 0 : 1,
                reached === undefined ? null : JSON.stringify(reached),
              ],
            ),
          );
        }
      });
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
    tenants: async () => {
      await prepared();
      const rows = await db.all(`SELECT DISTINCT "tenant" FROM ${table}`, []);
      return rows.map(({ tenant: held }) => String(held)).sort(byCodeUnit);
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
      await fenced.run(
        `INSERT INTO ${marks} ("tenant", "name", "value") VALUES (${p(1)}, ${p(2)}, ${p(3)}) ON CONFLICT ("tenant", "name") DO UPDATE SET "value" = EXCLUDED."value" WHERE ${marks}."value" < EXCLUDED."value"`,
        [tenant, name, value],
      );
    },
    clear: async () => {
      await prepared();
      await db.run(`DELETE FROM ${table} WHERE "tenant" = ${p(1)}`, [tenant]);
      await db.run(`DELETE FROM ${marks} WHERE "tenant" = ${p(1)}`, [tenant]);
      return true;
    },
    fence: {
      read: async () => {
        await prepared();
        return fenceStore.read();
      },
      set: async (asked) => {
        await prepared();
        return fenceStore.set(asked);
      },
    },
    close,
  };
};
