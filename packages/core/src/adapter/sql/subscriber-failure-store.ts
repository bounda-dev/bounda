import type {
  StoredSubscriberFailure,
  SubscriberFailureStore,
} from "../storage/subscriber-failure-store.ts";
import { decodeErrorText, encodeErrorText } from "./dead-letters.ts";
import type { SqlDialect } from "./dialect.ts";
import { codePointOrder } from "./order.ts";
import type { SqlExecutor } from "./sql-table.ts";

export interface CreateSqlSubscriberFailureStoreArgs {
  readonly db: SqlExecutor;
  /**
   * Already quoted.
   */
  readonly table: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface CreateSqlSubscriberFailureStoreFunction {
  (args: CreateSqlSubscriberFailureStoreArgs): SubscriberFailureStore;
}

const COLUMNS = `"subscriber", "position", "event_id", "event_type", "person", "error_name", "error_code", "error_message", "error_stack", "attempts", "first_failed_at", "last_failed_at", "resolved_at"`;

const failureOf = (row: Record<string, unknown>): StoredSubscriberFailure => ({
  subscriber: String(row.subscriber),
  position: Number(row.position),
  eventId: String(row.event_id),
  eventType: String(row.event_type),
  person: row.person === null ? null : String(row.person),
  errorName: String(row.error_name),
  ...(row.error_code === null ? {} : { errorCode: String(row.error_code) }),
  errorMessage: decodeErrorText(row.error_message),
  ...(row.error_stack === null ? {} : { errorStack: decodeErrorText(row.error_stack) }),
  attempts: Number(row.attempts),
  firstFailedAt: String(row.first_failed_at),
  lastFailedAt: String(row.last_failed_at),
  resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
});

/**
 * The subscriber failure store of SQLite and PostgreSQL alike, on the SQL both speak. A record is
 * one statement, so two instances failing on the same event at once count both attempts. The
 * error's text is kept as JSON, as a dead letter's is, so text in the clear and a sealed envelope
 * never read alike.
 */
export const createSqlSubscriberFailureStore: CreateSqlSubscriberFailureStoreFunction = ({
  db,
  table,
  dialect,
}) => {
  const p = dialect.placeholder;
  const again = `${table}."resolved_at" IS NULL AND ${table}."event_id" = EXCLUDED."event_id"`;
  return {
    record: (failure) =>
      db.run(
        `INSERT INTO ${table} (${COLUMNS}) VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, 1, ${p(10)}, ${p(11)}, NULL) ON CONFLICT ("subscriber") DO UPDATE SET "position" = EXCLUDED."position", "event_id" = EXCLUDED."event_id", "event_type" = EXCLUDED."event_type", "person" = EXCLUDED."person", "error_name" = EXCLUDED."error_name", "error_code" = EXCLUDED."error_code", "error_message" = EXCLUDED."error_message", "error_stack" = EXCLUDED."error_stack", "attempts" = CASE WHEN ${again} THEN ${table}."attempts" + 1 ELSE 1 END, "first_failed_at" = CASE WHEN ${again} THEN ${table}."first_failed_at" ELSE EXCLUDED."first_failed_at" END, "last_failed_at" = EXCLUDED."last_failed_at", "resolved_at" = NULL`,
        [
          failure.subscriber,
          failure.position,
          failure.eventId,
          failure.eventType,
          failure.person,
          failure.errorName,
          failure.errorCode ?? null,
          encodeErrorText(failure.errorMessage),
          failure.errorStack === undefined ? null : encodeErrorText(failure.errorStack),
          failure.failedAt,
          failure.failedAt,
        ],
      ),
    resolve: (subscriber, at) =>
      db.run(
        `UPDATE ${table} SET "resolved_at" = ${p(1)} WHERE "subscriber" = ${p(2)} AND "resolved_at" IS NULL`,
        [at.toISOString(), subscriber],
      ),
    reseal: (subscriber, { eventId, errorMessage, errorStack }) =>
      db.run(
        `UPDATE ${table} SET "error_message" = ${p(1)}, "error_stack" = ${p(2)} WHERE "subscriber" = ${p(3)} AND "event_id" = ${p(4)}`,
        [
          encodeErrorText(errorMessage),
          errorStack === undefined ? null : encodeErrorText(errorStack),
          subscriber,
          eventId,
        ],
      ),
    get: async (subscriber) => {
      const [row] = await db.all(`SELECT ${COLUMNS} FROM ${table} WHERE "subscriber" = ${p(1)}`, [
        subscriber,
      ]);
      return row === undefined ? null : failureOf(row);
    },
    list: async () =>
      (await db.all(`SELECT ${COLUMNS} FROM ${table}`, []))
        .map(failureOf)
        .sort((a, b) => codePointOrder(a.subscriber, b.subscriber)),
  };
};
