import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Adapter, CreateReadModelArgs } from "@bounda-dev/core/adapter";
import { type Client, createClient } from "@libsql/client";
import { createSqliteCheckpointStore } from "./checkpoint-store.ts";
import { createSqliteDatabase, type SqliteDatabase } from "./database.ts";
import { createSqliteDeadLetterStore } from "./dead-letter-store.ts";
import { createSqliteEventStore } from "./event-store.ts";
import { createSqliteInboxLedger } from "./inbox-ledger.ts";
import { resolveSqliteOptions, type SqliteOptions } from "./options.ts";
import { openSqliteReadModel, rebuildSqliteReadModel } from "./read-model.ts";
import { createSqliteScheduler } from "./scheduler.ts";
import { ensureStorageSchema, storageTablesFor } from "./schema.ts";

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

  return {
    kind: "bounda-adapter",
    name: "sqlite",
    options,
    createStorage: async () => {
      const { db } = open();
      const tables = storageTablesFor(tablePrefix);
      await ensureStorageSchema({ db, tables });
      return {
        eventStore: createSqliteEventStore({ db, table: tables.events }),
        checkpointStore: createSqliteCheckpointStore({ db, table: tables.checkpoints }),
        inboxLedger: createSqliteInboxLedger({ db, table: tables.inbox }),
        deadLetterStore: createSqliteDeadLetterStore({ db, table: tables.deadLetters }),
        scheduler: createSqliteScheduler({ db, table: tables.scheduledCommands }),
        close: release,
      };
    },
    createReadModel: <Row extends object>({ name, fields, logger }: CreateReadModelArgs) => {
      const { db, client } = open();
      return openSqliteReadModel<Row>({
        db,
        client,
        tablePrefix,
        name,
        fields,
        logger,
        close: release,
      });
    },
    rebuildReadModel: <Row extends object>({ name, fields, logger }: CreateReadModelArgs) => {
      const { db, client } = open();
      return rebuildSqliteReadModel<Row>({
        db,
        client,
        tablePrefix,
        name,
        fields,
        logger,
        close: release,
      });
    },
  };
};

export type { SqliteDatabase } from "./database.ts";
export type { ResolvedSqliteOptions, SqliteLocation, SqliteOptions } from "./options.ts";
export { DEFAULT_TABLE_PREFIX, resolveSqliteOptions } from "./options.ts";
export type {
  StorageSchemaAdditionsArgs,
  StorageSchemaAdditionsFunction,
  StorageTables,
} from "./schema.ts";
export { storageSchemaAdditions, storageSchemaStatements, storageTablesFor } from "./schema.ts";
