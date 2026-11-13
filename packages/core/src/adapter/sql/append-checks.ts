import {
  appendPersonsOf,
  checkAppend,
  type KeyRead,
  type RestrictionRead,
} from "../storage/append-checks.ts";
import type { AppendArgs } from "../storage/event-store.ts";
import { keyedPersonId } from "../storage/personal-key-store.ts";
import type { SqlDialect } from "./dialect.ts";
import { WHOLE_PERSON } from "./person-store.ts";
import type { SqlExecutor } from "./sql-table.ts";

export interface CheckSqlAppendArgs {
  /**
   * The append's own transaction.
   */
  readonly tx: Pick<SqlExecutor, "all">;
  readonly dialect: Pick<SqlDialect, "placeholder">;
  /**
   * Both already quoted.
   */
  readonly tables: {
    readonly personalKeys: string;
    readonly restrictions: string;
    /**
     * Locked with the rest when `lock` is given: a writer of a person's restrictions writes their
     * row too, and waits on it until the append commits.
     */
    readonly persons?: string;
  };
  readonly args: AppendArgs;
  /**
   * Appended to each read to lock the rows it reads until the transaction ends.
   */
  readonly lock?: "FOR SHARE";
}

export interface CheckSqlAppendFunction {
  (args: CheckSqlAppendArgs): Promise<void>;
}

/**
 * `checkAppend` on the keys and restrictions of SQLite and PostgreSQL alike, read in the append's
 * transaction: only the rows of the persons it names, none for an append that names nobody.
 */
export const checkSqlAppend: CheckSqlAppendFunction = async ({
  tx,
  dialect,
  tables,
  args,
  lock,
}) => {
  const { keyed, restricted } = appendPersonsOf(args);
  const read = async (columns: string, table: string, persons: readonly string[]) => {
    if (persons.length === 0) return [];
    const among = persons.map((_, index) => dialect.placeholder(index + 1)).join(", ");
    return tx.all(
      `SELECT ${columns} FROM ${table} WHERE "person" IN (${among})${lock === undefined ? "" : ` ${lock}`}`,
      persons,
    );
  };
  const keys = await read(
    `"person", "fingerprint", "category", "retained_since"`,
    tables.personalKeys,
    keyed,
  );
  const rows = await read(`"person", "category"`, tables.restrictions, restricted);
  if (lock !== undefined && tables.persons !== undefined) {
    await read(`"person"`, tables.persons, restricted);
  }
  const states = new Map<string, KeyRead>(
    keys.map((row) => [
      keyedPersonId({ person: String(row.person), fingerprint: String(row.fingerprint) }),
      {
        state:
          row.retained_since === null || row.retained_since === undefined ? "held" : "retained",
        category: String(row.category),
      },
    ]),
  );
  const restrictions = new Map<string, RestrictionRead[]>();
  for (const row of rows) {
    const person = String(row.person);
    restrictions.set(person, [
      ...(restrictions.get(person) ?? []),
      { category: row.category === WHOLE_PERSON ? null : String(row.category) },
    ]);
  }
  checkAppend({
    args,
    keyOf: (person, fingerprint) => states.get(keyedPersonId({ person, fingerprint })) ?? null,
    restrictionsOf: (person) => restrictions.get(person) ?? [],
  });
};
