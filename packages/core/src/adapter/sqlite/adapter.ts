import type {
  Adapter,
  CreateReadModelArgs,
  CreateReadModelRebuildArgs,
  StorageTransaction,
} from "../adapter.ts";
import { createSqlCheckpointStore } from "../sql/checkpoint-store.ts";
import type { SqlDatabase, SqlTransaction } from "../sql/database.ts";
import { sqliteDialect } from "../sql/dialect.ts";
import { createKnownEventTypes, type KnownEventTypes } from "../sql/event-types.ts";
import { createSqlForgetLedger, forgetLedgerStatements } from "../sql/forget-ledger.ts";
import { quoteIdentifier, storageTableNameFor } from "../sql/identifiers.ts";
import { createSqlPersonStore } from "../sql/person-store.ts";
import { createSqlPersonalKeyStore } from "../sql/personal-key-store.ts";
import { createSqliteDeadLetterStore } from "./dead-letter-store.ts";
import { createSqliteEventStore } from "./event-store.ts";
import { createSqliteIdempotencyStore } from "./idempotency-store.ts";
import { createSqliteInboxLedger } from "./inbox-ledger.ts";
import { openSqliteReadModel, rebuildSqliteReadModel } from "./read-model.ts";
import { createSqliteScheduler } from "./scheduler.ts";
import { ensureStorageSchema, storageTablesFor } from "./schema.ts";
import { createSqliteSnapshotStore } from "./snapshot-store.ts";

/**
 * One handle on a SQLite database: what the stores write through, and what queries receive as
 * `client.raw`. `db.write` must run one write transaction at a time: the read models take that
 * as their lock.
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
   * Called once for every `acquire`: when what it opened is closed, or as soon as opening it
   * fails.
   */
  readonly release: () => Promise<void>;
}

export interface CreateSqliteAdapterFunction {
  <Name extends string, Options, Raw = unknown>(
    args: CreateSqliteAdapterArgs<Name, Options, Raw>,
  ): Adapter<Name, Options>;
}

/**
 * A complete adapter over any SQLite: the storage schema and stores, read models and their
 * rebuilds. A host brings only the connection: libSQL for `@bounda-dev/sqlite`, a Durable
 * Object's storage for Cloudflare.
 */
export const createSqliteAdapter: CreateSqliteAdapterFunction = <
  Name extends string,
  Options,
  Raw = unknown,
>({
  name,
  options,
  tablePrefix,
  acquire,
  release,
}: CreateSqliteAdapterArgs<Name, Options, Raw>): Adapter<Name, Options> => {
  /**
   * Opens what `work` builds on an acquired connection, and releases it when `work` throws: the
   * stores whose `close` would release it never reach the caller.
   */
  const using = async <T>(work: (connection: SqliteConnection<Raw>) => Promise<T>): Promise<T> => {
    const connection = acquire();
    try {
      return await work(connection);
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
  };
  return {
    kind: "bounda-adapter",
    name,
    options,
    createStorage: () =>
      using(async ({ db }) => {
        const tables = storageTablesFor(tablePrefix);
        await ensureStorageSchema({ db, tables });
        const known = createKnownEventTypes();
        const storesOver = (database: SqlDatabase, types: KnownEventTypes): StorageTransaction => ({
          eventStore: createSqliteEventStore({
            db: database,
            table: tables.events,
            typesTable: tables.eventTypes,
            known: types,
            personalKeys: tables.personalKeys,
            persons: tables.persons,
          }),
          inboxLedger: createSqliteInboxLedger({ db: database, table: tables.inbox }),
          deadLetterStore: createSqliteDeadLetterStore({
            db: database,
            table: tables.deadLetters,
            personRows: tables.personRows,
          }),
          scheduler: createSqliteScheduler({
            db: database,
            table: tables.scheduledCommands,
            personRows: tables.personRows,
          }),
          idempotencyStore: createSqliteIdempotencyStore({
            db: database,
            table: tables.idempotencyKeys,
            personalKeys: tables.personalKeys,
            personRows: tables.personRows,
          }),
          personalKeys: createSqlPersonalKeyStore({
            db: database,
            table: tables.personalKeys,
            dialect: sqliteDialect,
          }),
          persons: createSqlPersonStore({
            db: database,
            table: tables.persons,
            dialect: sqliteDialect,
          }),
          snapshotStore: createSqliteSnapshotStore({
            db: database,
            table: tables.snapshots,
            personalKeys: tables.personalKeys,
            personRows: tables.personRows,
          }),
        });
        // The stores over an open transaction: their statements join it, and a `write` of their own
        // runs inside it instead of opening another, which SQLite would refuse.
        const boundTo = (tx: SqlTransaction): SqlDatabase => ({
          run: tx.run,
          all: tx.all,
          write: (work) => work(tx),
        });
        return {
          ...storesOver(db, known),
          checkpointStore: createSqlCheckpointStore({
            db,
            table: tables.checkpoints,
            dialect: sqliteDialect,
          }),
          transact: async (work) => {
            const pending = known.pending();
            const result = await db.write((tx) => work(storesOver(boundTo(tx), pending)));
            pending.commit();
            return result;
          },
          close: release,
        };
      }),
    createReadModel: <Row extends object>({
      name: readModel,
      fields,
      logger,
    }: CreateReadModelArgs) =>
      using(({ db, raw }) =>
        openSqliteReadModel<Row, Raw>({
          db,
          raw,
          tablePrefix,
          checkpoints: storageTablesFor(tablePrefix).checkpoints,
          name: readModel,
          fields,
          logger,
          close: release,
        }),
      ),
    rebuildReadModel: <Row extends object>({
      name: readModel,
      fields,
      logger,
      progress,
    }: CreateReadModelRebuildArgs) =>
      using(({ db, raw }) =>
        rebuildSqliteReadModel<Row, Raw>({
          db,
          raw,
          tablePrefix,
          checkpoints: storageTablesFor(tablePrefix).checkpoints,
          name: readModel,
          fields,
          logger,
          close: release,
          progress,
        }),
      ),
    createForgetLedger: async ({ tenant }) => {
      const table = quoteIdentifier(
        storageTableNameFor({ prefix: tablePrefix, table: "forgetLedger" }),
      );
      const { db } = acquire();
      return createSqlForgetLedger({
        db,
        table,
        dialect: sqliteDialect,
        tenant,
        ensureSchema: async () => {
          for (const statement of forgetLedgerStatements(table, sqliteDialect)) {
            await db.run(statement, []);
          }
        },
        close: release,
      });
    },
  };
};
