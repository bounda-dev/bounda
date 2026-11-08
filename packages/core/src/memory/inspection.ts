import { DEFAULT_TABLE_PREFIX, storageTableNameFor } from "../adapter/sql/identifiers.ts";
import type { InspectedTable } from "../adapter/storage/inspection.ts";
import type { StoreEntries } from "./entries.ts";

export interface StorageTableArgs {
  /**
   * The store's name in the SQL adapters, so a report reads alike on every adapter.
   */
  readonly table: string;
  readonly key: readonly string[];
  readonly opaque?: readonly string[];
  readonly rows: readonly object[];
}

export interface StorageTableFunction {
  (args: StorageTableArgs): InspectedTable;
}

export const storageTable: StorageTableFunction = ({ table, key, opaque = [], rows }) => ({
  name: storageTableNameFor({ prefix: DEFAULT_TABLE_PREFIX, table }),
  key,
  opaque,
  rows: rows as readonly Readonly<Record<string, unknown>>[],
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
