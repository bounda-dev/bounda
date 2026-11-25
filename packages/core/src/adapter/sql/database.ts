import type { SqlFragment } from "./query-builder.ts";
import type { SqlExecutor } from "./sql-table.ts";

/**
 * A SQL connection as the stores see it. `write` runs the work in one transaction that commits
 * when it resolves and rolls back when it throws.
 */
export interface SqlDatabase extends SqlExecutor {
  write<T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T>;
}

/**
 * The statements of one open transaction, plus the driver's handle on it: what a projection gets
 * as `client.raw` while its batch runs, so hand-written SQL joins the transaction.
 */
export interface SqlTransaction extends SqlExecutor {
  readonly raw: unknown;
  /**
   * Runs the statements in order, in as few round trips to the database as the driver allows, and
   * fails with the first that fails. A driver whose statements never leave the process has no
   * need of it: `runInOrder` runs them one by one there.
   */
  readonly batch?: (statements: readonly SqlFragment[]) => Promise<void>;
}

export interface RunInOrderFunction {
  (tx: SqlTransaction, statements: readonly SqlFragment[]): Promise<void>;
}

/**
 * Runs `statements` in order within `tx`, through the driver's `batch` when it has one and one by
 * one otherwise, and fails with the first that fails. Sends nothing when there is nothing to run.
 */
export const runInOrder: RunInOrderFunction = async (tx, statements) => {
  if (statements.length === 0) return;
  if (tx.batch !== undefined) {
    await tx.batch(statements);
    return;
  }
  for (const { sql, params } of statements) await tx.run(sql, params);
};
