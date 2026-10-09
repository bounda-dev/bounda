import type { Adapter } from "@bounda-dev/core/adapter";
import { createSqliteAdapter } from "@bounda-dev/core/adapter/sqlite";
import { type CloudflareOptions, DEFAULT_TABLE_PREFIX } from "./definition.ts";
import { createDurableSqlDatabase, type DurableSqlStorage } from "./sql-database.ts";

export interface DurableObjectAdapterArgs {
  readonly storage: DurableSqlStorage;
  readonly options: CloudflareOptions;
}

export interface DurableObjectAdapterFunction {
  (args: DurableObjectAdapterArgs): Adapter<"cloudflare", CloudflareOptions>;
}

export const durableObjectAdapter: DurableObjectAdapterFunction = ({ storage, options }) => {
  const db = createDurableSqlDatabase(storage);
  return createSqliteAdapter({
    name: "cloudflare",
    options,
    tablePrefix: options.tablePrefix ?? DEFAULT_TABLE_PREFIX,
    acquire: () => ({ db, raw: storage.sql }),
    // Nothing to close: the storage lives as long as the object.
    release: async () => {},
  });
};
