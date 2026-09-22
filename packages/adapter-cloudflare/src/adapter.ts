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

/**
 * The adapter over one Durable Object's SQLite: the shared SQLite storage of
 * `@bounda-dev/core/adapter/sqlite` on `ctx.storage.sql`. The storage lives as long as the
 * object, so releasing it closes nothing. Queries get `ctx.storage.sql` as `client.raw`.
 */
export const durableObjectAdapter: DurableObjectAdapterFunction = ({ storage, options }) => {
  const db = createDurableSqlDatabase(storage);
  return createSqliteAdapter({
    name: "cloudflare",
    options,
    tablePrefix: options.tablePrefix ?? DEFAULT_TABLE_PREFIX,
    acquire: () => ({ db, raw: storage.sql }),
    release: async () => {},
  });
};
