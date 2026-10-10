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
  readonly raw: Client;
  uses: number;
}

/**
 * How long a statement on a local file waits for another process's lock before failing with
 * `SQLITE_BUSY`.
 */
const BUSY_TIMEOUT_MS = 5_000;

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
        ...(location === "file" ? { timeout: BUSY_TIMEOUT_MS } : {}),
      });
      const { db, raw } = createSqliteDatabase(client, {
        local: location !== "remote",
        wal: location === "file",
      });
      connection = { client, db, raw, uses: 0 };
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
      const { db, raw } = open();
      return { db, raw };
    },
    release,
  });
};

export type { SqliteOptions } from "./options.ts";
