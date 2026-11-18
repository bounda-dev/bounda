import { IdempotencyKeyTakenError } from "../../contracts/errors.ts";
import type { IdempotencyRecord, IdempotencyStore, KeyedPerson, StoredAnswer } from "../index.ts";
import type { SqlDatabase } from "../sql/database.ts";
import { heldKeys, naming, outsideKept } from "./held-keys.ts";
import { PERSON_INDEXED } from "./schema.ts";

export interface CreateSqliteIdempotencyStoreArgs {
  readonly db: SqlDatabase;
  readonly table: string;
  // The personal keys a record's persons must hold for `put` to keep its answer.
  readonly personalKeys: string;
  // Where the rows that name a person are indexed by person.
  readonly personRows: string;
}

export interface CreateSqliteIdempotencyStoreFunction {
  (args: CreateSqliteIdempotencyStoreArgs): IdempotencyStore;
}

const COLUMNS = `"key", "outcome", "expires_at", "persons"`;

// The column keeps its name from before answers were sealed; an erased answer is JSON `null`.
const toRecord = (row: Record<string, unknown>): IdempotencyRecord => ({
  key: String(row.key),
  answer: JSON.parse(String(row.outcome)) as StoredAnswer | null,
  expiresAt: String(row.expires_at),
  persons: JSON.parse(String(row.persons)) as KeyedPerson[],
});

export const createSqliteIdempotencyStore: CreateSqliteIdempotencyStoreFunction = ({
  db,
  table,
  personalKeys,
  personRows,
}) => {
  const get: IdempotencyStore["get"] = async ({ key, now }) => {
    const [row] = await db.all(
      `SELECT ${COLUMNS} FROM ${table} WHERE "key" = ? AND "expires_at" > ?`,
      [key, now.toISOString()],
    );
    return row === undefined ? null : toRecord(row);
  };
  const named = naming({ personRows, indexed: PERSON_INDEXED.idempotencyKeys });
  return {
    get,
    // One statement whose row comes back only when the key was free or expired, so two dispatches
    // racing for it can never both record; the answer and its persons are kept only when every
    // person the record names with a fingerprint holds that key, so none is kept beside a forget.
    put: async ({ key, answer, expiresAt, now, persons }) => {
      const named = JSON.stringify(persons);
      const rows = await db.all(
        `INSERT INTO ${table} (${COLUMNS})
       SELECT ?, CASE WHEN "held" THEN ? ELSE 'null' END, ?, CASE WHEN "held" THEN ? ELSE '[]' END
       FROM (SELECT ${heldKeys(personalKeys)} AS "held") WHERE true
       ON CONFLICT ("key") DO UPDATE SET
         "outcome" = excluded."outcome",
         "expires_at" = excluded."expires_at",
         "persons" = excluded."persons"
       WHERE ${table}."expires_at" <= ?
       RETURNING "key"`,
        [key, JSON.stringify(answer), expiresAt, named, named, named, now.toISOString()],
      );
      if (rows.length === 0) throw new IdempotencyKeyTakenError(key);
    },
    listByPerson: async ({ person, now, after, limit }) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} WHERE ${named} AND "expires_at" > ? AND (? IS NULL OR "key" > ?) ORDER BY "key" LIMIT ?`,
          [person, now.toISOString(), after ?? null, after ?? null, limit ?? -1],
        )
      ).map(toRecord),
    list: async ({ now, after, limit, offset = 0 }) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} WHERE "expires_at" > ? AND (? IS NULL OR "key" > ?) ORDER BY "key" LIMIT ? OFFSET ?`,
          [now.toISOString(), after ?? null, after ?? null, limit ?? -1, offset],
        )
      ).map(toRecord),
    // Filing it elsewhere copies it there erased before it leaves `key`: a crash between the two
    // leaves both, and erasing it again moves it once more.
    erase: async ({ key, filed = key, now }) => {
      if (filed === key) {
        await db.run(
          `UPDATE ${table} SET "outcome" = 'null', "persons" = '[]' WHERE "key" = ? AND "expires_at" > ?`,
          [key, now.toISOString()],
        );
        return;
      }
      await db.run(
        `INSERT INTO ${table} (${COLUMNS}) SELECT ?, 'null', "expires_at", '[]' FROM ${table} WHERE "key" = ? AND "expires_at" > ?
       ON CONFLICT ("key") DO UPDATE SET "outcome" = 'null', "expires_at" = excluded."expires_at", "persons" = '[]' WHERE ${table}."expires_at" <= ?`,
        [filed, key, now.toISOString(), now.toISOString()],
      );
      await db.run(`DELETE FROM ${table} WHERE "key" = ? AND "expires_at" > ?`, [
        key,
        now.toISOString(),
      ]);
    },
    reseal: ({ key, from, answer, persons, now }) =>
      db.run(
        `UPDATE ${table} SET "outcome" = ?, "persons" = ? WHERE "key" = ? AND "outcome" = ? AND "expires_at" > ?`,
        [
          JSON.stringify(answer),
          JSON.stringify(persons),
          key,
          JSON.stringify(from),
          now.toISOString(),
        ],
      ),
    clear: () => db.run(`DELETE FROM ${table}`, []),
    purge: async ({ now }) => {
      const rows = await db.all(`DELETE FROM ${table} WHERE "expires_at" <= ? RETURNING "key"`, [
        now.toISOString(),
      ]);
      return rows.length;
    },
    forget: (person, keep = []) =>
      db.run(
        `UPDATE ${table} SET "outcome" = 'null', "persons" = '[]' WHERE ${named} AND ${outsideKept(table)}`,
        [person, person, JSON.stringify(keep)],
      ),
  };
};
