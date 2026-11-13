import { DEFAULT_TABLE_PREFIX, storageTableNameFor } from "../adapter/sql/identifiers.ts";
import {
  type InspectedStore,
  type InspectedTable,
  opaqueColumnsOf,
} from "../adapter/storage/inspection.ts";
import type { StoreEntries } from "./entries.ts";
import { compareStored } from "./table.ts";

export interface StorageTableArgs {
  /**
   * Named as the SQL adapters name its table, so a report reads alike on every adapter.
   */
  readonly table: Exclude<InspectedStore, "readModel">;
  readonly key: readonly string[];
  readonly rows: readonly object[];
}

export interface StorageTableFunction {
  (args: StorageTableArgs): InspectedTable;
}

export const storageTable: StorageTableFunction = ({ table, key, rows }) => ({
  name: storageTableNameFor({ prefix: DEFAULT_TABLE_PREFIX, table }),
  store: table,
  key,
  opaque: opaqueColumnsOf(table, []),
  rows: byKey(rows as readonly Readonly<Record<string, unknown>>[], key),
});

export interface ByKeyFunction {
  (
    rows: readonly Readonly<Record<string, unknown>>[],
    key: readonly string[],
  ): readonly Readonly<Record<string, unknown>>[];
}

/**
 * The rows in the order of their key, as a SQL adapter reads them.
 */
export const byKey: ByKeyFunction = (rows, key) =>
  [...rows].sort((a, b) => {
    for (const column of key) {
      const order = compareStored(a[column], b[column]);
      if (order !== 0) return order;
    }
    return 0;
  });

export interface EntriesRowsFunction {
  <Key>(entries: StoreEntries<Key>, key?: string): readonly Readonly<Record<string, unknown>>[];
}

/**
 * A store's entries as rows, each with the key it is filed by under `key` when the entry does not
 * hold it.
 */
export const entriesRows: EntriesRowsFunction = (entries, key) =>
  entries.list().map(([at, value]) => ({
    ...(key === undefined ? {} : { [key]: at }),
    ...(value as Readonly<Record<string, unknown>>),
  }));
