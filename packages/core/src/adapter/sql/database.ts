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

export interface WithBatchedWritesFunction {
  <T>(tx: SqlTransaction, work: (tx: SqlTransaction) => Promise<T>): Promise<T>;
}

/**
 * Runs `work` over `tx` with its writes held back and sent through `runInOrder` together, each
 * group when the work next reads and the last as it resolves: every statement reaches the database
 * in the order the work sent it, in as few round trips as the driver allows. A write that fails
 * fails the read or the end it is sent at, and the work with it even when the work catches that
 * error, so nothing after it is sent and the transaction rolls back. `raw` is the driver's own,
 * which would jump the writes held back: work that uses it must not go through here.
 */
export const withBatchedWrites: WithBatchedWritesFunction = async (tx, work) => {
  let waiting: SqlFragment[] = [];
  let failure: { readonly error: unknown } | undefined;
  const healthy = (): void => {
    if (failure !== undefined) throw failure.error;
  };
  const send = async (): Promise<void> => {
    healthy();
    const statements = waiting;
    waiting = [];
    try {
      await runInOrder(tx, statements);
    } catch (error) {
      failure = { error };
      throw error;
    }
  };
  const result = await work({
    raw: tx.raw,
    run: async (sql, params) => {
      healthy();
      waiting.push({ sql, params });
    },
    batch: async (statements) => {
      healthy();
      waiting.push(...statements);
    },
    all: async (sql, params) => {
      await send();
      return tx.all(sql, params);
    },
  });
  await send();
  return result;
};
