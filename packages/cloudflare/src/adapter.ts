import type { Adapter } from "@bounda-dev/core/adapter";
import { DEFAULT_TABLE_PREFIX } from "@bounda-dev/core/adapter/sql";
import { createSqliteAdapter } from "@bounda-dev/core/adapter/sqlite";
import type { CloudflareOptions } from "./definition.ts";
import { createDurableSqlDatabase, type DurableSqlStorage } from "./sql-database.ts";

export interface DurableObjectAdapterArgs {
  /**
   * The object's `ctx.storage`, or the `state.storage` `runInDurableObject` hands a test.
   */
  readonly storage: DurableSqlStorage;
  /**
   * The options the app's `cloudflare()` takes. Defaults to none.
   */
  readonly options?: CloudflareOptions;
}

export interface DurableObjectAdapterFunction {
  (args: DurableObjectAdapterArgs): Adapter<"cloudflare", CloudflareOptions>;
}

/**
 * The adapter over a Durable Object's own SQLite, as the object opens it for its app. For a test
 * that reads the object's storage from inside it, through `runInDurableObject`: give it to
 * `expectForgotten` from `@bounda-dev/core/testing` to search every table the object keeps.
 */
export const durableObjectAdapter: DurableObjectAdapterFunction = ({ storage, options = {} }) => {
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
