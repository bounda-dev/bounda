import { IdempotencyKeyTakenError } from "../../contracts/errors.ts";
import type { DispatchOutcome, IdempotencyRecord, IdempotencyStore } from "../index.ts";
import type { SqlDatabase } from "../sql/database.ts";

export interface CreateSqliteIdempotencyStoreArgs {
  readonly db: SqlDatabase;
  readonly table: string;
  // The personal keys a record's persons must hold for `put` to write it.
  readonly personalKeys: string;
}

export interface CreateSqliteIdempotencyStoreFunction {
  (args: CreateSqliteIdempotencyStoreArgs): IdempotencyStore;
}

const toRecord = (row: Record<string, unknown>): IdempotencyRecord => ({
  key: String(row.key),
  fingerprint: String(row.fingerprint),
  outcome: JSON.parse(String(row.outcome)) as DispatchOutcome,
  expiresAt: String(row.expires_at),
  persons: JSON.parse(String(row.persons)) as string[],
});

export const createSqliteIdempotencyStore: CreateSqliteIdempotencyStoreFunction = ({
  db,
  table,
  personalKeys,
}) => {
  const get: IdempotencyStore["get"] = async ({ key, now }) => {
    const [row] = await db.all(
      `SELECT "key", "fingerprint", "outcome", "expires_at", "persons" FROM ${table} WHERE "key" = ? AND "expires_at" > ?`,
      [key, now.toISOString()],
    );
    return row === undefined ? null : toRecord(row);
  };
  return {
    get,
    // One statement whose row comes back only when the key was free or expired and every person
    // the record names has a key, so two dispatches racing for it can never both record, nor one
    // record beside a forget. No row back with no live record under the key is the second case.
    put: async ({ key, fingerprint, outcome, expiresAt, now, persons }) => {
      const rows = await db.all(
        `INSERT INTO ${table} ("key", "fingerprint", "outcome", "expires_at", "persons")
       SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM ${personalKeys} WHERE "person" IN (SELECT "value" FROM json_each(?))) = ?
       ON CONFLICT ("key") DO UPDATE SET
         "fingerprint" = excluded."fingerprint",
         "outcome" = excluded."outcome",
         "expires_at" = excluded."expires_at",
         "persons" = excluded."persons"
       WHERE ${table}."expires_at" <= ?
       RETURNING "key"`,
        [
          key,
          fingerprint,
          JSON.stringify(outcome),
          expiresAt,
          JSON.stringify(persons),
          JSON.stringify(persons),
          persons.length,
          now.toISOString(),
        ],
      );
      if (rows.length === 0 && (await get({ key, now })) !== null) {
        throw new IdempotencyKeyTakenError(key);
      }
    },
    purge: async ({ now }) => {
      const rows = await db.all(`DELETE FROM ${table} WHERE "expires_at" <= ? RETURNING "key"`, [
        now.toISOString(),
      ]);
      return rows.length;
    },
    forget: (person) =>
      db.run(
        `DELETE FROM ${table} WHERE EXISTS (SELECT 1 FROM json_each(${table}."persons") WHERE "value" = ?)`,
        [person],
      ),
  };
};
