import { appendPersonsOf, checkAppend } from "../storage/append-checks.ts";
import type { AppendArgs } from "../storage/event-store.ts";
import { keyedPersonId } from "../storage/personal-key-store.ts";
import type { SqlDialect } from "./dialect.ts";
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
  readonly tables: { readonly personalKeys: string; readonly persons: string };
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
 * `checkAppend` on the keys and person rows of SQLite and PostgreSQL alike, read in the append's
 * transaction: only the rows of the persons it names, none for an append that names nobody.
 */
export const checkSqlAppend: CheckSqlAppendFunction = async ({
  tx,
  dialect,
  tables,
  args,
  lock,
}) => {
  const { keyed, touched } = appendPersonsOf(args);
  const read = async (columns: string, table: string, persons: readonly string[]) => {
    if (persons.length === 0) return [];
    const among = persons.map((_, index) => dialect.placeholder(index + 1)).join(", ");
    return tx.all(
      `SELECT ${columns} FROM ${table} WHERE "person" IN (${among})${lock === undefined ? "" : ` ${lock}`}`,
      persons,
    );
  };
  const keys = await read(`"person", "fingerprint", "retained_since"`, tables.personalKeys, keyed);
  const rows = await read(`"person", "restricted_since"`, tables.persons, touched);
  const states = new Map(
    keys.map((row) => [
      keyedPersonId({ person: String(row.person), fingerprint: String(row.fingerprint) }),
      row.retained_since === null || row.retained_since === undefined
        ? ("held" as const)
        : ("retained" as const),
    ]),
  );
  const restricted = new Set(
    rows.filter((row) => row.restricted_since !== null).map((row) => String(row.person)),
  );
  checkAppend({
    args,
    keyOf: (person, fingerprint) => states.get(keyedPersonId({ person, fingerprint })) ?? "gone",
    restricted: (person) => restricted.has(person),
  });
};
