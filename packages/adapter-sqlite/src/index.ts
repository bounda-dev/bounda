import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Adapter } from "@bounda-dev/core/adapter";
import { createSqliteAdapter } from "@bounda-dev/core/adapter/sqlite";
import { type Client, createClient } from "@libsql/client";
import { createSqliteDatabase, type SqliteDatabase } from "./database.ts";
import { resolveSqliteOptions, type SqliteOptions } from "./options.ts";

/**
 * The adapter `sqlite(...)` returns: what `bounda.config.ts` holds under `storage` or
 * `readModels`.
 */
export type SqliteAdapter = Adapter<"sqlite", SqliteOptions>;

export interface SqliteFunction {
  (options: SqliteOptions): SqliteAdapter;
}

interface Connection {
  readonly client: Client;
  readonly db: SqliteDatabase;
  uses: number;
}

/**
 * SQLite storage through libSQL: a local file (`{ path }`, its directory is created), memory
 * (`{ memory: true }`) or a
 * libSQL server such as Turso (`{ url, authToken }`). Storage and read models opened from the
 * same adapter share one connection, closed when the last of them closes.
 */
export const sqlite: SqliteFunction = (options) => {
  const { url, authToken, tablePrefix } = resolveSqliteOptions(options);
  let connection: Connection | null = null;

  const open = (): Connection => {
    if (connection === null) {
      if ("path" in options) mkdirSync(dirname(options.path), { recursive: true });
      const client = createClient({ url, ...(authToken === undefined ? {} : { authToken }) });
      connection = { client, db: createSqliteDatabase(client), uses: 0 };
    }
    connection.uses += 1;
    return connection;
  };

  const release = async (): Promise<void> => {
    if (connection === null) return;
    connection.uses -= 1;
    if (connection.uses > 0) return;
    connection.client.close();
    connection = null;
  };

  return createSqliteAdapter({
    name: "sqlite",
    options,
    tablePrefix,
    acquire: () => {
      const { db, client } = open();
      return { db, raw: client };
    },
    release,
  });
};

export type {
  StorageSchemaAdditionsArgs,
  StorageSchemaAdditionsFunction,
  StorageTables,
} from "@bounda-dev/core/adapter/sqlite";
export {
  storageSchemaAdditions,
  storageSchemaStatements,
  storageTablesFor,
} from "@bounda-dev/core/adapter/sqlite";
export type { SqliteDatabase } from "./database.ts";
export type { ResolvedSqliteOptions, SqliteLocation, SqliteOptions } from "./options.ts";
export { DEFAULT_TABLE_PREFIX, resolveSqliteOptions } from "./options.ts";
