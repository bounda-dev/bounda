import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Adapter } from "@bounda-dev/core/adapter";
import { createSqliteAdapter, SQLITE_BUSY_TIMEOUT_MS } from "@bounda-dev/core/adapter/sqlite";
import { type Client, createClient } from "@libsql/client";
import { createSqliteDatabase, type LibsqlConnection } from "./database.ts";
import { resolveSqliteOptions, type SqliteOptions } from "./options.ts";

/**
 * The adapter `sqlite(...)` returns: what `bounda.config.ts` holds under `storage` or
 * `readModels`.
 */
export type SqliteAdapter = Adapter<"sqlite", SqliteOptions>;

export interface SqliteFunction {
  (options: SqliteOptions): SqliteAdapter;
}

interface Connection extends LibsqlConnection {
  readonly client: Client;
  uses: number;
}

/**
 * SQLite storage through libSQL: a local file (`{ path }`, its directory is created), memory
 * (`{ memory: true }`) or a libSQL server such as Turso (`{ url, authToken }`). Storage and read
 * models opened from the same adapter share one connection, closed when the last of them closes.
 * A file is kept in WAL mode, and a statement on it waits a few seconds for another process's
 * write before failing.
 */
export const sqlite: SqliteFunction = (options) => {
  const { url, authToken, tablePrefix, location } = resolveSqliteOptions(options);
  let connection: Connection | null = null;

  const open = (): Connection => {
    if (connection === null) {
      if ("path" in options) mkdirSync(dirname(options.path), { recursive: true });
      const client = createClient({
        url,
        ...(authToken === undefined ? {} : { authToken }),
        ...(location === "file" ? { timeout: SQLITE_BUSY_TIMEOUT_MS } : {}),
      });
      const opened = createSqliteDatabase(client, {
        local: location !== "remote",
        wal: location === "file",
      });
      connection = { ...opened, client, uses: 0 };
    }
    connection.uses += 1;
    return connection;
  };

  // The client closes once what it runs has settled, unless it was handed out again meanwhile.
  const release = async (): Promise<void> => {
    const releasing = connection;
    if (releasing === null) return;
    releasing.uses -= 1;
    if (releasing.uses > 0) return;
    await releasing.settled();
    if (releasing.uses > 0 || connection !== releasing) return;
    releasing.client.close();
    connection = null;
  };

  return createSqliteAdapter({
    name: "sqlite",
    options,
    tablePrefix,
    acquire: () => {
      const { db, raw } = open();
      return { db, raw };
    },
    release,
  });
};

export type { SqliteOptions } from "./options.ts";
