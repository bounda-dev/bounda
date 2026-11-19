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
  decodeReadPersons,
  encodeErrorText,
  postgresqlDialect,
} from "@bounda-dev/core/adapter/sql";
import type { PostgresqlDatabase } from "./database.ts";
import { naming, outsideKept } from "./held-keys.ts";

export interface CreatePostgresqlDeadLetterStoreArgs {
  readonly db: PostgresqlDatabase;
  readonly table: string;
  // The storage's restrictions table, which `purge` and `removeHeld` check in their statement.
  readonly restrictions: string;
}

export interface CreatePostgresqlDeadLetterStoreFunction {
  (args: CreatePostgresqlDeadLetterStoreArgs): DeadLetterStore;
}

const COLUMNS =
  '"id", "kind", "handler", "event_id", "event_type", "aggregate_type", "aggregate_id", "person", "error_type", "error_name", "error_code", "error_message", "error_stack", "attempts", "first_failed_at", "last_failed_at", "status", "resolved_at", "payload", "persons", "state_person", "read_persons"';

const toLetter = (row: Record<string, unknown>): StoredDeadLetter => ({
  id: String(row.id),
  kind: String(row.kind) as DeadLetterKind,
  handler: String(row.handler),
  eventId: String(row.event_id),
  eventType: String(row.event_type),
  aggregateType: String(row.aggregate_type),
  aggregateId: String(row.aggregate_id),
  person: row.person === null || row.person === undefined ? null : String(row.person),
  ...(row.state_person === null || row.state_person === undefined
    ? {}
    : { statePerson: String(row.state_person) }),
  ...decodeReadPersons(row.read_persons),
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
  restrictions,
}) => {
  // A condition true for a letter, the row `l`, that names a person with a restriction.
  const held = `EXISTS (SELECT 1 FROM ${restrictions} AS "r" WHERE "r"."person" IN ("l"."person", "l"."state_person") OR "l"."read_persons" @> jsonb_build_array("r"."person") OR "l"."persons" @> jsonb_build_array(jsonb_build_object('person', "r"."person")))`;
  const firstResolvedAt = async (holding: boolean): Promise<Date | null> => {
    const [row] = await db.all(
      `SELECT "resolved_at" FROM ${table} AS "l" WHERE "resolved_at" IS NOT NULL AND ${holding ? "" : "NOT "}${held} ORDER BY "resolved_at" LIMIT 1`,
      [],
    );
    return row === undefined ? null : new Date(String(row.resolved_at));
  };
  const get = async (id: string): Promise<StoredDeadLetter | null> => {
    const [row] = await db.all(`SELECT ${COLUMNS} FROM ${table} WHERE "id" = $1`, [id]);
    return row === undefined ? null : toLetter(row);
  };

  return {
    add: async (letter) => {
      await db.run(
        `INSERT INTO ${table} (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'failed', NULL, $17, $18, $19, $20) ON CONFLICT ("id") DO NOTHING`,
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
          letter.statePerson ?? null,
          postgresqlDialect.encode("json", letter.readPersons ?? []),
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
    reseal: (
      id,
      { person, statePerson, readPersons, errorMessage, errorStack, payload, persons },
    ) =>
      db.run(
        `UPDATE ${table} SET "person" = $1, "error_message" = $2, "error_stack" = $3, "payload" = $4, "persons" = $5, "state_person" = $7, "read_persons" = $8 WHERE "id" = $6`,
        [
          person,
          encodeErrorText(errorMessage),
          errorStack === undefined ? null : encodeErrorText(errorStack),
          postgresqlDialect.encode("json", payload),
          postgresqlDialect.encode("json", persons ?? []),
          id,
          statePerson ?? null,
          postgresqlDialect.encode("json", readPersons ?? []),
        ],
      ),
    listByPerson: async ({ person, after, limit }) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} WHERE ("person" = $1 OR "state_person" = $1 OR "read_persons" @> jsonb_build_array($1::text) OR ${naming("$1")}) AND ($2::text IS NULL OR "id" COLLATE "C" > $2::text) ORDER BY "id" COLLATE "C" LIMIT $3`,
          [person, after ?? null, limit ?? null],
        )
      ).map(toLetter),
    scan: async ({ after, limit }) =>
      (
        await db.all(
          after === undefined
            ? `SELECT ${COLUMNS} FROM ${table} ORDER BY "id" COLLATE "C" LIMIT $1`
            : `SELECT ${COLUMNS} FROM ${table} WHERE "id" COLLATE "C" > $1 ORDER BY "id" COLLATE "C" LIMIT $2`,
          after === undefined ? [limit] : [after, limit],
        )
      ).map(toLetter),
    forget: async (person, keep = []) =>
      (
        await db.all(
          `DELETE FROM ${table} WHERE ${naming("$1")} AND ${outsideKept({ person: "$1", keep: "$2" })} RETURNING ${COLUMNS}`,
          [person, postgresqlDialect.encode("json", keep)],
        )
      )
        .map(toLetter)
        .sort(byFirstFailure),
    firstResolvedAt: () => firstResolvedAt(false),
    firstHeldAt: () => firstResolvedAt(true),
    purge: async ({ resolvedBy, limit }) =>
      (
        await db.all(
          `DELETE FROM ${table} WHERE "id" IN (SELECT "id" FROM ${table} AS "l" WHERE "resolved_at" <= $1 AND NOT ${held} ORDER BY "resolved_at", "id" COLLATE "C" LIMIT $2) RETURNING "id"`,
          [resolvedBy.toISOString(), limit],
        )
      ).length,
    listHeld: async ({ resolvedBy, after, limit }) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} AS "l" WHERE "resolved_at" <= $1 AND ${held} AND ($2::text IS NULL OR "id" COLLATE "C" > $2::text) ORDER BY "id" COLLATE "C" LIMIT $3`,
          [resolvedBy.toISOString(), after ?? null, limit],
        )
      ).map(toLetter),
    removeHeld: async (letter, unlessRestricted) => {
      const unless =
        unlessRestricted.length === 0
          ? ""
          : ` AND NOT EXISTS (SELECT 1 FROM ${restrictions} WHERE "person" IN (${unlessRestricted.map((_, index) => `$${index + 5}`).join(", ")}))`;
      const removed = await db.all(
        `DELETE FROM ${table} WHERE "id" = $1 AND "resolved_at" = $2 AND "error_message"::jsonb = $3::jsonb AND "persons" = $4::jsonb${unless} RETURNING "id"`,
        [
          letter.id,
          letter.resolvedAt ?? null,
          postgresqlDialect.encode("json", letter.errorMessage),
          postgresqlDialect.encode("json", letter.persons ?? []),
          ...unlessRestricted,
        ],
      );
      return removed.length > 0;
    },
    failedByHandler: async () =>
      (
        await db.all(
          `SELECT "kind", "handler", count(*) AS "count" FROM ${table} WHERE "status" = 'failed' GROUP BY "kind", "handler" ORDER BY "kind" COLLATE "C", "handler" COLLATE "C"`,
          [],
        )
      ).map((row) => ({
        kind: String(row.kind) as DeadLetterKind,
        handler: String(row.handler),
        count: Number(row.count),
      })),
    clear: async (keepEventId) => {
      await db.run(`DELETE FROM ${table} WHERE $1::text IS NULL OR "event_id" <> $1::text`, [
        keepEventId ?? null,
      ]);
    },
  };
};
