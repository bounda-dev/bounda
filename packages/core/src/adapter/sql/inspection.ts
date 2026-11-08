import type { InspectedTable } from "../storage/inspection.ts";
import { storageTableNameFor } from "./identifiers.ts";
import type { SqlExecutor } from "./sql-table.ts";

export interface QuoteNameFunction {
  (name: string): string;
}

/**
 * Double-quotes any name, escaping the quotes in it: a name read from the catalog, which need not
 * be one Bounda would accept as an identifier.
 */
export const quoteName: QuoteNameFunction = (name) => `"${name.replaceAll('"', '""')}"`;

export interface InspectSqlTableArgs {
  readonly db: SqlExecutor;
  readonly prefix: string;
  readonly name: string;
  /**
   * The table as a statement names it, schema included where there is one.
   */
  readonly from: string;
  readonly key: readonly string[];
}

export interface InspectSqlTableFunction {
  (args: InspectSqlTableArgs): Promise<InspectedTable>;
}

/**
 * Reads every row of a table, in the order of its key.
 */
export const inspectSqlTable: InspectSqlTableFunction = async ({ db, prefix, name, from, key }) => {
  const order = key.length === 0 ? "" : ` ORDER BY ${key.map(quoteName).join(", ")}`;
  return {
    name,
    key,
    opaque:
      name === storageTableNameFor({ prefix, table: "personalKeys" }) ? ["key", "fingerprint"] : [],
    rows: await db.all(`SELECT * FROM ${from}${order}`, []),
  };
};
