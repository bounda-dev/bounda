import type { Adapter, CreateReadModelArgs } from "../adapter.ts";
import type { SqlDatabase } from "../sql/database.ts";
import { createSqliteCheckpointStore } from "./checkpoint-store.ts";
import { createSqliteDeadLetterStore } from "./dead-letter-store.ts";
import { createSqliteEventStore } from "./event-store.ts";
import { createSqliteInboxLedger } from "./inbox-ledger.ts";
import { openSqliteReadModel, rebuildSqliteReadModel } from "./read-model.ts";
import { createSqliteScheduler } from "./scheduler.ts";
import { ensureStorageSchema, storageTablesFor } from "./schema.ts";

/**
 * One handle on a SQLite database: what the stores write through, and what queries receive as
 * `client.raw`.
 */
export interface SqliteConnection<Raw = unknown> {
  readonly db: SqlDatabase;
  readonly raw: Raw;
}

export interface CreateSqliteAdapterArgs<Name extends string, Options, Raw> {
  readonly name: Name;
  readonly options: Options;
  readonly tablePrefix: string;
  /**
   * Hands out the connection, opening it if needed. Called once for the storage and once for
   * every read model or rebuild opened.
   */
  readonly acquire: () => SqliteConnection<Raw>;
  /**
   * Called once for every `acquire` when what it opened is closed.
   */
  readonly release: () => Promise<void>;
}

export interface CreateSqliteAdapterFunction {
  <Name extends string, Options, Raw = unknown>(
    args: CreateSqliteAdapterArgs<Name, Options, Raw>,
  ): Adapter<Name, Options>;
}

/**
 * A complete adapter over any SQLite: the storage schema and the six stores, read models and
 * their rebuilds, all speaking the same SQL. A host brings the connection: libSQL for
 * `@bounda-dev/adapter-sqlite`, a Durable Object's storage for Cloudflare.
 */
export const createSqliteAdapter: CreateSqliteAdapterFunction = ({
  name,
  options,
  tablePrefix,
  acquire,
  release,
}) => ({
  kind: "bounda-adapter",
  name,
  options,
  createStorage: async () => {
    const { db } = acquire();
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
  createReadModel: <Row extends object>({
    name: readModel,
    fields,
    logger,
  }: CreateReadModelArgs) => {
    const { db, raw } = acquire();
    return openSqliteReadModel<Row>({
      db,
      raw,
      tablePrefix,
      name: readModel,
      fields,
      logger,
      close: release,
    });
  },
  rebuildReadModel: <Row extends object>({
    name: readModel,
    fields,
    logger,
  }: CreateReadModelArgs) => {
    const { db, raw } = acquire();
    return rebuildSqliteReadModel<Row>({
      db,
      raw,
      tablePrefix,
      name: readModel,
      fields,
      logger,
      close: release,
    });
  },
});
