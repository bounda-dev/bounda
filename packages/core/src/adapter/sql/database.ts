import type { SqlExecutor } from "./sql-table.ts";

/**
 * A SQL connection as the stores see it: two statements and write transactions. `write` runs
 * the work in one transaction that commits when it resolves and rolls back when it throws.
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
}
