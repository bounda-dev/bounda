import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { Table } from "../../adapter/storage/table.ts";
import type { BlindIndexer } from "../personal-data/blind-index.ts";

export interface TableIndexerArgs {
  readonly indexer: BlindIndexer | null;
  readonly readModel: string;
  readonly checkpoints: Pick<CheckpointStore, "get" | "set">;
  readonly table: Pick<Table<Record<string, unknown>>, "findMany">;
  /**
   * Whether it is part of a transaction that writes the table, as a projection's batch is.
   */
  readonly writes: boolean;
}

export interface TableIndexerFunction {
  (args: TableIndexerArgs): Promise<BlindIndexer | null>;
}

/**
 * The indexer of a read model's table, under the database's key its rows are indexed under.
 */
export const tableIndexer: TableIndexerFunction = async ({
  indexer,
  readModel,
  checkpoints,
  table,
  writes,
}) =>
  indexer === null
    ? null
    : indexer.forTable({
        readModel,
        checkpoints,
        isEmpty: async () => (await table.findMany({ limit: 1 })).length === 0,
        writes,
      });

export interface LazyTableIndexerFunction {
  (args: Omit<TableIndexerArgs, "writes">): BlindIndexer | null;
}

/**
 * `tableIndexer` for a query, resolved at its first index, once: a query that matches nothing by
 * a blind index reads no mark.
 */
export const lazyTableIndexer: LazyTableIndexerFunction = (args) => {
  const { indexer } = args;
  if (indexer === null) return null;
  let resolved: Promise<BlindIndexer> | undefined;
  const resolve = (): Promise<BlindIndexer> => {
    resolved ??= tableIndexer({ ...args, writes: false }) as Promise<BlindIndexer>;
    return resolved;
  };
  return {
    get epoch() {
      return indexer.epoch;
    },
    index: async (index) => (await resolve()).index(index),
    forTable: (table) => indexer.forTable(table),
    pinned: () => indexer.pinned(),
    // Under every key, read without the table's mark: no swap between the mark and the statement
    // can make a query miss its rows.
    indexAll: (index) => indexer.indexAll(index),
  };
};
