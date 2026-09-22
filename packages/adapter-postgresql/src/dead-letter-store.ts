import type {
  DeadLetter,
  DeadLetterErrorType,
  DeadLetterKind,
  DeadLetterStatus,
  DeadLetterStore,
  ListDeadLettersArgs,
} from "@bounda-dev/core/adapter";
import type { PostgresqlDatabase } from "./database.ts";

export interface CreatePostgresqlDeadLetterStoreArgs {
  readonly db: PostgresqlDatabase;
  readonly table: string;
}

export interface CreatePostgresqlDeadLetterStoreFunction {
  (args: CreatePostgresqlDeadLetterStoreArgs): DeadLetterStore;
}

const COLUMNS =
  '"id", "kind", "subscriber", "event_id", "event_type", "aggregate_type", "aggregate_id", "error_type", "error_message", "error_stack", "attempts", "first_failed_at", "last_failed_at", "status", "payload"';

const toLetter = (row: Record<string, unknown>): DeadLetter => ({
  id: String(row.id),
  kind: String(row.kind) as DeadLetterKind,
  subscriber: String(row.subscriber),
  eventId: String(row.event_id),
  eventType: String(row.event_type),
  aggregateType: String(row.aggregate_type),
  aggregateId: String(row.aggregate_id),
  errorType: String(row.error_type) as DeadLetterErrorType,
  errorMessage: String(row.error_message),
  ...(row.error_stack === null || row.error_stack === undefined
    ? {}
    : { errorStack: String(row.error_stack) }),
  attempts: Number(row.attempts),
  firstFailedAt: String(row.first_failed_at),
  lastFailedAt: String(row.last_failed_at),
  status: String(row.status) as DeadLetterStatus,
  ...(row.payload === null || row.payload === undefined ? {} : { payload: row.payload }),
});

const filters = (
  args: ListDeadLettersArgs,
): { readonly sql: string; readonly params: unknown[] } => {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of [
    ["kind", args.kind],
    ["subscriber", args.subscriber],
    ["status", args.status],
  ] as const) {
    if (value !== undefined) {
      params.push(value);
      clauses.push(`"${column}" = $${params.length}`);
    }
  }
  return { sql: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`, params };
};

/**
 * Dead letters on one table. `add` ignores a duplicate id and returns the stored row.
 */
export const createPostgresqlDeadLetterStore: CreatePostgresqlDeadLetterStoreFunction = ({
  db,
  table,
}) => {
  const get = async (id: string): Promise<DeadLetter | null> => {
    const [row] = await db.all(`SELECT ${COLUMNS} FROM ${table} WHERE "id" = $1`, [id]);
    return row === undefined ? null : toLetter(row);
  };

  return {
    add: async (letter) => {
      await db.run(
        `INSERT INTO ${table} (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'failed', $14) ON CONFLICT ("id") DO NOTHING`,
        [
          letter.id,
          letter.kind,
          letter.subscriber,
          letter.eventId,
          letter.eventType,
          letter.aggregateType,
          letter.aggregateId,
          letter.errorType,
          letter.errorMessage,
          letter.errorStack ?? null,
          letter.attempts,
          letter.firstFailedAt,
          letter.lastFailedAt,
          letter.payload === undefined ? null : letter.payload,
        ],
      );
      return (await get(letter.id)) as DeadLetter;
    },
    get,
    list: async (args = {}) => {
      const where = filters(args);
      const rows = await db.all(
        `SELECT ${COLUMNS} FROM ${table}${where.sql} ORDER BY "first_failed_at", "id" LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
        [...where.params, args.limit ?? null, args.offset ?? 0],
      );
      return rows.map(toLetter);
    },
    count: async (args = {}) => {
      const where = filters(args);
      const [row] = await db.all(
        `SELECT COUNT(*) AS "count" FROM ${table}${where.sql}`,
        where.params,
      );
      return Number(row?.count ?? 0);
    },
    updateStatus: (id, status) =>
      db.run(`UPDATE ${table} SET "status" = $1 WHERE "id" = $2`, [status, id]),
    remove: (id) => db.run(`DELETE FROM ${table} WHERE "id" = $1`, [id]),
  };
};
