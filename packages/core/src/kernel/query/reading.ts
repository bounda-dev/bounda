import type { ReadModelStorage } from "../../adapter/adapter.ts";
import type { RestrictionView } from "../../adapter/storage/restricted-persons.ts";
import type { ReadClient, Table } from "../../adapter/storage/table.ts";
import { ConfigurationError } from "../../contracts/errors.ts";

type Row = Record<string, unknown>;

export interface ReadingStores {
  readonly table: Table<Row>;
  readonly client: ReadClient<Row>;
  /**
   * The values of the `person` field in the rows read so far, in order, repeats included.
   */
  readonly persons: readonly string[];
  /**
   * Whether `client.raw` was taken: what the driver reads names no one Bounda can see.
   */
  readonly unattributed: boolean;
}

export interface ReadingArgs {
  readonly storage: Pick<ReadModelStorage, "table" | "client" | "restricted">;
  readonly readModel: string;
  /**
   * The field marked `.person()`.
   */
  readonly person: string;
  /**
   * The fields marked `.personal()`.
   */
  readonly personal: readonly string[];
  readonly view: RestrictionView;
}

export interface ReadingFunction {
  (args: ReadingArgs): ReadingStores;
}

/**
 * A read model's `table` and `client` as a query reads them: the rows of the persons `view` leaves
 * out are not read, and whose rows they read is noted. `table` leaves them out in the statement
 * itself; `client` drops them from what its SQL answers, so a row holding a field marked
 * `.personal()` without the one marked `.person()` cannot be told apart and is refused. `count`
 * reads no row, so it notes no one; taking `client.raw` is noted as a read of rows whose persons
 * are unknown.
 */
export const reading: ReadingFunction = ({
  storage: { table: all, client, restricted },
  readModel,
  person,
  personal,
  view,
}) => {
  const table = view === "all" ? all : restricted[view];
  const persons: string[] = [];
  let unattributed = false;
  const note = <Found extends Row | null>(row: Found): Found => {
    const value = row?.[person];
    if (typeof value === "string") persons.push(value);
    return row;
  };
  const noteAll = (rows: readonly Row[]): readonly Row[] => {
    for (const row of rows) note(row);
    return rows;
  };
  const visible = async (rows: readonly Row[]): Promise<readonly Row[]> => {
    for (const row of rows) {
      if (row[person] === undefined && personal.some((field) => row[field] !== undefined)) {
        throw new ConfigurationError(
          `A query of read model "${readModel}" read a field marked .personal() through client without "${person}", the field marked .person(): select it too, so the rows of restricted persons are left out`,
        );
      }
    }
    if (view === "all") return rows;
    const named = rows.flatMap((row) => (typeof row[person] === "string" ? [row[person]] : []));
    const leftOut = await restricted.among(named, view);
    return leftOut.size === 0
      ? rows
      : rows.filter((row) => typeof row[person] !== "string" || !leftOut.has(row[person]));
  };
  return {
    persons,
    get unattributed() {
      return unattributed;
    },
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
      get: async (sql, params) => {
        const [row] = await visible(asRows(await client.get(sql, params)));
        return note(row ?? null);
      },
      all: async (sql, params) => noteAll(await visible(await client.all(sql, params))),
      get raw() {
        unattributed = true;
        return client.raw;
      },
    },
  };
};

const asRows = (row: Row | null): readonly Row[] => (row === null ? [] : [row]);
