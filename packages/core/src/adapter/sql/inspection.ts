import {
  type InspectedStore,
  type InspectedTable,
  opaqueColumnsOf,
  STORAGE_STORES,
} from "../storage/inspection.ts";
import { storageTableNameFor, tableNameFor } from "./identifiers.ts";
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

export interface StoreOfTableArgs {
  readonly prefix: string;
  readonly name: string;
}

export interface StoreOfTableFunction {
  (args: StoreOfTableArgs): InspectedStore | null;
}

/**
 * Which store a table under `prefix` holds, by its name.
 */
export const storeOfTable: StoreOfTableFunction = ({ prefix, name }) => {
  const store = STORAGE_STORES.find((table) => storageTableNameFor({ prefix, table }) === name);
  if (store !== undefined) return store;
  return name.startsWith(tableNameFor({ prefix, readModel: "" })) ? "readModel" : null;
};

/**
 * Reads every row of a table, in the order of its key.
 */
export const inspectSqlTable: InspectSqlTableFunction = async ({ db, prefix, name, from, key }) => {
  const order = key.length === 0 ? "" : ` ORDER BY ${key.map(quoteName).join(", ")}`;
  const store = storeOfTable({ prefix, name });
  const rows = await db.all(`SELECT * FROM ${from}${order}`, []);
  return { name, store, key, opaque: opaqueColumnsOf(store, Object.keys(rows[0] ?? {})), rows };
};
