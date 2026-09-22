import type { SqlExecutor } from "./sql-table.ts";

/**
 * A SQL connection as the stores see it: two statements and write transactions. `write` runs
 * the work in one transaction that commits when it resolves and rolls back when it throws.
 */
export interface SqlDatabase extends SqlExecutor {
  write<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
