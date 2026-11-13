import type {
  Adapter,
  CreateReadModelArgs,
  CreateReadModelRebuildArgs,
  SchemaScopeName,
  StorageTransaction,
} from "../adapter.ts";
import { createSqlCheckpointStore } from "../sql/checkpoint-store.ts";
import type { SqlDatabase, SqlTransaction } from "../sql/database.ts";
import { sqliteDialect } from "../sql/dialect.ts";
import { createSqlForgetLedger } from "../sql/forget-ledger.ts";
import { quoteIdentifier, storageTableNameFor } from "../sql/identifiers.ts";
import { inspectSqlTable, quoteName } from "../sql/inspection.ts";
import {
  readSchemaVersions,
  type SchemaScope,
  schemaMigrationsTableFor,
} from "../sql/migrations.ts";
import { createSqlPersonStore } from "../sql/person-store.ts";
import { createSqlPersonalKeyStore } from "../sql/personal-key-store.ts";
import { createSqlSubscriberFailureStore } from "../sql/subscriber-failure-store.ts";
import { createSqliteDeadLetterStore } from "./dead-letter-store.ts";
import { createSqliteEventStore } from "./event-store.ts";
import { createSqliteIdempotencyStore } from "./idempotency-store.ts";
import { createSqliteInboxLedger } from "./inbox-ledger.ts";
import {
  isMissingSqliteTable,
  migrateSqlite,
  sqliteCheckpointsScope,
  sqliteForgetLedgerScope,
  sqliteStorageScope,
} from "./migrations.ts";
import { openSqliteReadModel, rebuildSqliteReadModel } from "./read-model.ts";
import { createSqliteScheduler } from "./scheduler.ts";
import { storageTablesFor } from "./schema.ts";
import { createSqliteSnapshotStore } from "./snapshot-store.ts";

/**
 * One handle on a SQLite database: what the stores write through, and what queries receive as
 * `client.raw`. `db.write` must run one write transaction at a time: the read models take that
 * as their lock.
 */
export interface SqliteConnection<Raw = unknown> {
  readonly db: SqlDatabase;
  readonly raw: Raw;
  /**
   * Whether an error is the driver's `SQLITE_BUSY`, so a migration waits for another process's
   * instead of failing. Leave it out when this connection is the database's only writer.
   */
  readonly isBusy?: (error: unknown) => boolean;
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
  const ledgerTable = quoteIdentifier(
    storageTableNameFor({ prefix: tablePrefix, table: "forgetLedger" }),
  );
  const scopes: Readonly<Record<SchemaScopeName, SchemaScope>> = {
    storage: sqliteStorageScope(storageTablesFor(tablePrefix)),
    checkpoints: sqliteCheckpointsScope(storageTablesFor(tablePrefix)),
    "forget-ledger": sqliteForgetLedgerScope(ledgerTable),
  };
  const versionsOn = (db: SqlDatabase) =>
    readSchemaVersions({
      db,
      table: schemaMigrationsTableFor(tablePrefix),
      scopes: Object.values(scopes),
      isMissingTable: isMissingSqliteTable,
    });
  // A connection for one call, handed back whatever the call does.
  const briefly = async <T>(
    work: (connection: SqliteConnection<Raw>) => Promise<T>,
  ): Promise<T> => {
    const connection = acquire();
    try {
      return await work(connection);
    } finally {
      await release();
    }
  };
  return {
    kind: "bounda-adapter",
    name,
    options,
    schemaVersions: () => briefly(({ db }) => versionsOn(db)),
    migrate: (names) =>
      briefly(async ({ db, isBusy }) => {
        await migrateSqlite({
          db,
          isBusy,
          prefix: tablePrefix,
          scopes: names.map((scope) => scopes[scope]),
        });
        return versionsOn(db);
      }),
    createStorage: () =>
      using(async ({ db, isBusy }) => {
        const tables = storageTablesFor(tablePrefix);
        await migrateSqlite({
          db,
          isBusy,
          prefix: tablePrefix,
          scopes: [sqliteStorageScope(tables), sqliteCheckpointsScope(tables)],
        });
        const storesOver = (database: SqlDatabase): StorageTransaction => ({
          eventStore: createSqliteEventStore({
            db: database,
            table: tables.events,
            personalKeys: tables.personalKeys,
            restrictions: tables.restrictions,
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
            persons: tables.persons,
            restrictions: tables.restrictions,
            dialect: sqliteDialect,
          }),
          persons: createSqlPersonStore({
            db: database,
            table: tables.persons,
            restrictions: tables.restrictions,
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
          ...storesOver(db),
          checkpointStore: createSqlCheckpointStore({
            db,
            table: tables.checkpoints,
            dialect: sqliteDialect,
          }),
          subscriberFailures: createSqlSubscriberFailureStore({
            db,
            table: tables.subscriberFailures,
            dialect: sqliteDialect,
          }),
          transact: (work) => db.write((tx) => work(storesOver(boundTo(tx)))),
          close: release,
        };
      }),
    createReadModel: <Row extends object>({
      name: readModel,
      fields,
      logger,
    }: CreateReadModelArgs) =>
      using(({ db, raw, isBusy }) =>
        openSqliteReadModel<Row, Raw>({
          db,
          raw,
          isBusy,
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
      using(({ db, raw, isBusy }) =>
        rebuildSqliteReadModel<Row, Raw>({
          db,
          raw,
          isBusy,
          tablePrefix,
          checkpoints: storageTablesFor(tablePrefix).checkpoints,
          name: readModel,
          fields,
          logger,
          close: release,
          progress,
        }),
      ),
    inspect: async () => {
      const { db } = acquire();
      try {
        const names = await db.all(
          `SELECT "name" FROM sqlite_master WHERE "type" = 'table' ORDER BY "name"`,
          [],
        );
        const inspected = [];
        for (const { name } of names) {
          const table = String(name);
          if (!table.startsWith(tablePrefix)) continue;
          const columns = await db.all(`PRAGMA table_info(${quoteName(table)})`, []);
          const key = columns
            .filter(({ pk }) => Number(pk) > 0)
            .sort((a, b) => Number(a.pk) - Number(b.pk))
            .map(({ name: column }) => String(column));
          inspected.push(
            await inspectSqlTable({
              db,
              prefix: tablePrefix,
              name: table,
              from: quoteName(table),
              key,
            }),
          );
        }
        return inspected;
      } finally {
        await release();
      }
    },
    createForgetLedger: async ({ tenant }) => {
      const table = quoteIdentifier(
        storageTableNameFor({ prefix: tablePrefix, table: "forgetLedger" }),
      );
      const { db, isBusy } = acquire();
      return createSqlForgetLedger({
        db,
        table,
        dialect: sqliteDialect,
        tenant,
        ensureSchema: () =>
          migrateSqlite({
            db,
            isBusy,
            prefix: tablePrefix,
            scopes: [sqliteForgetLedgerScope(table)],
          }),
        close: release,
      });
    },
  };
};
