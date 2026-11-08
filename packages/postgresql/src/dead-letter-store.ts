import { DeadLetterSettledError } from "@bounda-dev/core";
import type {
  DeadLetterErrorType,
  DeadLetterKind,
  DeadLetterStatus,
  DeadLetterStore,
  KeyedPerson,
  ListDeadLettersArgs,
  StoredDeadLetter,
} from "@bounda-dev/core/adapter";
import {
  byFirstFailure,
  decodeErrorText,
  encodeErrorText,
  postgresqlDialect,
} from "@bounda-dev/core/adapter/sql";
import type { PostgresqlDatabase } from "./database.ts";
import { naming } from "./held-keys.ts";

export interface CreatePostgresqlDeadLetterStoreArgs {
  readonly db: PostgresqlDatabase;
  readonly table: string;
}

export interface CreatePostgresqlDeadLetterStoreFunction {
  (args: CreatePostgresqlDeadLetterStoreArgs): DeadLetterStore;
}

const COLUMNS =
  '"id", "kind", "handler", "event_id", "event_type", "aggregate_type", "aggregate_id", "person", "error_type", "error_name", "error_code", "error_message", "error_stack", "attempts", "first_failed_at", "last_failed_at", "status", "resolved_at", "payload", "persons"';

const toLetter = (row: Record<string, unknown>): StoredDeadLetter => ({
  id: String(row.id),
  kind: String(row.kind) as DeadLetterKind,
  handler: String(row.handler),
  eventId: String(row.event_id),
  eventType: String(row.event_type),
  aggregateType: String(row.aggregate_type),
  aggregateId: String(row.aggregate_id),
  person: row.person === null || row.person === undefined ? null : String(row.person),
  errorType: String(row.error_type) as DeadLetterErrorType,
  errorName: String(row.error_name),
  ...(row.error_code === null || row.error_code === undefined
    ? {}
    : { errorCode: String(row.error_code) }),
  errorMessage: decodeErrorText(row.error_message),
  ...(row.error_stack === null || row.error_stack === undefined
    ? {}
    : { errorStack: decodeErrorText(row.error_stack) }),
  attempts: Number(row.attempts),
  firstFailedAt: String(row.first_failed_at),
  lastFailedAt: String(row.last_failed_at),
  status: String(row.status) as DeadLetterStatus,
  ...(row.resolved_at === null || row.resolved_at === undefined
    ? {}
    : { resolvedAt: String(row.resolved_at) }),
  ...(row.payload === null || row.payload === undefined ? {} : { payload: row.payload }),
  ...((row.persons as KeyedPerson[]).length === 0 ? {} : { persons: row.persons as KeyedPerson[] }),
});

const filters = (
  args: ListDeadLettersArgs,
): { readonly sql: string; readonly params: unknown[] } => {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of [
    ["kind", args.kind],
    ["handler", args.handler],
    ["status", args.status],
  ] as const) {
    if (value !== undefined) {
      params.push(value);
      clauses.push(`"${column}" = $${params.length}`);
    }
  }
  return { sql: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`, params };
};

export const createPostgresqlDeadLetterStore: CreatePostgresqlDeadLetterStoreFunction = ({
  db,
  table,
}) => {
  const get = async (id: string): Promise<StoredDeadLetter | null> => {
    const [row] = await db.all(`SELECT ${COLUMNS} FROM ${table} WHERE "id" = $1`, [id]);
    return row === undefined ? null : toLetter(row);
  };

  return {
    add: async (letter) => {
      await db.run(
        `INSERT INTO ${table} (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'failed', NULL, $17, $18) ON CONFLICT ("id") DO NOTHING`,
        [
          letter.id,
          letter.kind,
          letter.handler,
          letter.eventId,
          letter.eventType,
          letter.aggregateType,
          letter.aggregateId,
          letter.person,
          letter.errorType,
          letter.errorName,
          letter.errorCode ?? null,
          encodeErrorText(letter.errorMessage),
          letter.errorStack === undefined ? null : encodeErrorText(letter.errorStack),
          letter.attempts,
          letter.firstFailedAt,
          letter.lastFailedAt,
          postgresqlDialect.encode("json", letter.payload),
          postgresqlDialect.encode("json", letter.persons ?? []),
        ],
      );
      return (await get(letter.id)) as StoredDeadLetter;
    },
    get,
    list: async (args = {}) => {
      const where = filters(args);
      const rows = await db.all(
        `SELECT ${COLUMNS} FROM ${table}${where.sql} ORDER BY "first_failed_at", "id" COLLATE "C" LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
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
    listFailed: async ({ person, errorCode }) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} WHERE "status" = 'failed' AND "person" = $1 AND "error_code" = $2 ORDER BY "first_failed_at", "id" COLLATE "C"`,
          [person, errorCode],
        )
      ).map(toLetter),
    updateStatus: async (id, status, at) => {
      const updated = await db.all(
        `UPDATE ${table} SET "status" = $1, "resolved_at" = $2 WHERE "id" = $3 AND "status" = 'failed' RETURNING "id"`,
        [status, at.toISOString(), id],
      );
      if (updated.length === 0) throw new DeadLetterSettledError({ id });
    },
    remove: (id) => db.run(`DELETE FROM ${table} WHERE "id" = $1`, [id]),
    reseal: (id, { person, errorMessage, errorStack, payload, persons }) =>
      db.run(
        `UPDATE ${table} SET "person" = $1, "error_message" = $2, "error_stack" = $3, "payload" = $4, "persons" = $5 WHERE "id" = $6`,
        [
          person,
          encodeErrorText(errorMessage),
          errorStack === undefined ? null : encodeErrorText(errorStack),
          postgresqlDialect.encode("json", payload),
          postgresqlDialect.encode("json", persons ?? []),
          id,
        ],
      ),
    listByPerson: async (person) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} WHERE "person" = $1 OR ${naming("$1")} ORDER BY "first_failed_at", "id" COLLATE "C"`,
          [person],
        )
      ).map(toLetter),
    forget: async (person) =>
      (await db.all(`DELETE FROM ${table} WHERE ${naming("$1")} RETURNING ${COLUMNS}`, [person]))
        .map(toLetter)
        .sort(byFirstFailure),
    firstResolvedAt: async () => {
      const [row] = await db.all(
        `SELECT "resolved_at" FROM ${table} WHERE "resolved_at" IS NOT NULL ORDER BY "resolved_at" LIMIT 1`,
        [],
      );
      return row === undefined ? null : new Date(String(row.resolved_at));
    },
    purge: async ({ resolvedBy, limit }) =>
      (
        await db.all(
          `DELETE FROM ${table} WHERE "id" IN (SELECT "id" FROM ${table} WHERE "resolved_at" <= $1 ORDER BY "resolved_at", "id" COLLATE "C" LIMIT $2) RETURNING "id"`,
          [resolvedBy.toISOString(), limit],
        )
      ).length,
  };
};
