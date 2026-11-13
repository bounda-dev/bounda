import type { ReadClient, StoredReadClient } from "../../adapter/storage/table.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { OpenedRow, SealingContext } from "./sealed-rows.ts";
import { indexOf } from "./sealed-rows.ts";
import { openAll } from "./sealed-table.ts";

type Row = Record<string, unknown>;

export interface SealedClientArgs {
  readonly context: SealingContext;
  readonly client: StoredReadClient<Row>;
  // What each row read went through, as `sealedTable` takes it.
  readonly read?: (rows: readonly Row[]) => Promise<readonly OpenedRow[]>;
  // Called each time `raw` is taken.
  readonly onRaw?: () => void;
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
}) => {
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
    blindIndex: async (field, value) => {
      const indexed = context.layout.personal.find(
        (candidate) => candidate.field === field && candidate.indexField !== null,
      );
      if (indexed === undefined) {
        throw new ConfigurationError(
          `Read model "${context.layout.readModel}": field "${field}" has no blind index; only a field marked .personal() with .index() or .unique() has one`,
        );
      }
      return indexOf({ context, field: indexed, value });
    },
  };
};
