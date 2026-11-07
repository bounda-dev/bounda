import type { ReadModelStorage } from "../../adapter/adapter.ts";
import type { ReadClient, Table } from "../../adapter/storage/table.ts";

type Row = Record<string, unknown>;

export interface ReadingStores {
  readonly table: Table<Row>;
  readonly client: ReadClient<Row>;
  /**
   * The values of the `person` field in the rows read so far, in order, repeats included.
   */
  readonly persons: readonly string[];
}

export interface ReadingArgs {
  readonly storage: Pick<ReadModelStorage, "table" | "client">;
  readonly person: string;
}

export interface ReadingFunction {
  (args: ReadingArgs): ReadingStores;
}

/**
 * A read model's `table` and `client` that note whose rows they read. `count` reads no row, and
 * `client.raw` is the driver's own, so neither is noted.
 */
export const reading: ReadingFunction = ({ storage: { table, client }, person }) => {
  const persons: string[] = [];
  const note = <Found extends Row | null>(row: Found): Found => {
    const value = row?.[person];
    if (typeof value === "string") persons.push(value);
    return row;
  };
  const noteAll = (rows: readonly Row[]): readonly Row[] => {
    for (const row of rows) note(row);
    return rows;
  };
  return {
    persons,
    table: {
      upsert: (row) => table.upsert(row),
      insert: (row) => table.insert(row),
      update: (where, patch) => table.update(where, patch),
      delete: (where) => table.delete(where),
      count: (where) => table.count(where),
      findOne: async (where) => note(await table.findOne(where)),
      findMany: async (args) => noteAll(await table.findMany(args)),
    },
    client: {
      get: async (sql, params) => note(await client.get(sql, params)),
      all: async (sql, params) => noteAll(await client.all(sql, params)),
      raw: client.raw,
    },
  };
};
