import type { ReadClient, StoredReadClient } from "../../adapter/storage/table.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { personsOf, type ReturnedRead } from "../ports/returns.ts";
import type { OpenedRow, SealingContext } from "./sealed-rows.ts";
import { indexesOf, indexOf } from "./sealed-rows.ts";
import { openAll } from "./sealed-table.ts";

type Row = Record<string, unknown>;

export interface SealedClientArgs {
  readonly context: SealingContext;
  readonly client: StoredReadClient<Row>;
  // What each row read went through, as `sealedTable` takes it.
  readonly read?: (rows: readonly Row[]) => Promise<readonly OpenedRow[]>;
  // Called each time `raw` is taken.
  readonly onRaw?: () => void;
  // What `rawReadOf` says a raw read returned; nothing is noted without it.
  readonly rawRead?: ((reads: readonly ReturnedRead[]) => Promise<void>) | undefined;
}

export interface SealedClientFunction {
  (args: SealedClientArgs): ReadClient<Row>;
}

// The read model's client as projections and queries use it, over the adapter's: rows its SQL
// answers come out opened, `raw` reads what is stored.
export const sealedClient: SealedClientFunction = ({
  context,
  client,
  read = (rows) => openAll(context, rows),
  onRaw = () => undefined,
  rawRead = async () => undefined,
}) => {
  const ownCategories = [...new Set(context.layout.personal.map(({ category }) => category))];
  const indexedField = (field: string) => {
    const indexed = context.layout.personal.find(
      (candidate) => candidate.field === field && candidate.indexField !== null,
    );
    if (indexed === undefined) {
      throw new ConfigurationError(
        `Read model "${context.layout.readModel}": field "${field}" has no blind index; only a field marked .personal() with .index() or .unique() has one`,
      );
    }
    return indexed;
  };
  const opened = async (rows: readonly Row[]): Promise<readonly Row[]> =>
    (await read(rows)).map(({ row }) => row);
  return {
    get: async (sql, params) => {
      const found = await client.get(sql, params);
      return found === null ? null : ((await opened([found]))[0] ?? null);
    },
    all: async (sql, params) => opened(await client.all(sql, params)),
    get raw() {
      onRaw();
      return client.raw;
    },
    blindIndex: async (field, value) => indexOf({ context, field: indexedField(field), value }),
    blindIndexes: async (field, value) => indexesOf({ context, field: indexedField(field), value }),
    rawReadOf: async (named, options) => {
      const where = `Read model "${context.layout.readModel}": rawReadOf`;
      const categories = options?.categories ?? ownCategories;
      if (categories.length === 0) {
        throw new ConfigurationError(
          `${where} names no categories, and the read model marks no field .personal(): name the categories the read returned`,
        );
      }
      const unknown = categories.find(
        (category) => context.layout.categories?.has(category) === false,
      );
      if (unknown !== undefined) {
        throw new ConfigurationError(
          `${where} names the category ${JSON.stringify(unknown)}, which the app does not have`,
        );
      }
      await rawRead(personsOf(where, named).map((person) => ({ person, categories })));
    },
  };
};
