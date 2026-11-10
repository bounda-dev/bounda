import type {
  Adapter,
  CreateReadModelArgs,
  CreateReadModelRebuildArgs,
  SchemaScopeName,
  StorageTransaction,
} from "@bounda-dev/core/adapter";
import {
  createSqlCheckpointStore,
  createSqlForgetLedger,
  createSqlPersonalKeyStore,
  createSqlPersonStore,
  createSqlSubscriberFailureStore,
  inspectSqlTable,
  postgresqlDialect,
  quoteName,
  type SchemaScope,
  type SqlTransaction,
} from "@bounda-dev/core/adapter/sql";
import postgres, { type Sql } from "postgres";
import { createPostgresqlDatabase, type PostgresqlDatabase } from "./database.ts";
import { createPostgresqlDeadLetterStore } from "./dead-letter-store.ts";
import { createPostgresqlEventNotifier } from "./event-notifier.ts";
import { createPostgresqlEventStore } from "./event-store.ts";
import { createPostgresqlIdempotencyStore } from "./idempotency-store.ts";
import { createPostgresqlInboxLedger } from "./inbox-ledger.ts";
import {
  migratePostgresql,
  postgresqlCheckpointsScope,
  postgresqlForgetLedgerScope,
  postgresqlStorageScope,
  readPostgresqlSchemaVersions,
} from "./migrations.ts";
import { type PostgresqlOptions, resolvePostgresqlOptions } from "./options.ts";
import { openPostgresqlReadModel, rebuildPostgresqlReadModel } from "./read-model.ts";
import { createPostgresqlScheduler } from "./scheduler.ts";
import { storageTablesFor } from "./schema.ts";
import { createPostgresqlSnapshotStore } from "./snapshot-store.ts";

/**
 * The adapter `postgresql(...)` returns: what `bounda.config.ts` holds under `storage` or
 * `readModels`.
 */
export type PostgresqlAdapter = Adapter<"postgresql", PostgresqlOptions>;

export interface PostgresqlFunction {
  (options: PostgresqlOptions): PostgresqlAdapter;
}

interface Connection {
  readonly sql: Sql;
  readonly db: PostgresqlDatabase;
  uses: number;
}

/**
 * PostgreSQL storage through Postgres.js. Storage and read models opened from the same adapter
 * share one pool, closed when the last of them closes. Every table lives in `schema`, which is
 * created on first use.
 */
export const postgresql: PostgresqlFunction = (options) => {
  const { url, schema, tablePrefix, maxConnections, ...connection } =
    resolvePostgresqlOptions(options);
  const tables = storageTablesFor({ prefix: tablePrefix, schema });
  let shared: Connection | null = null;

  const open = (): Connection => {
    if (shared === null) {
      const settings = {
        max: maxConnections,
        connection: { search_path: schema },
        onnotice: () => undefined,
      };
      const sql =
        url === undefined ? postgres({ ...connection, ...settings }) : postgres(url, settings);
      shared = { sql, db: createPostgresqlDatabase(sql), uses: 0 };
    }
    shared.uses += 1;
    return shared;
  };

  const release = async (): Promise<void> => {
    if (shared === null) return;
    shared.uses -= 1;
    if (shared.uses > 0) return;
    const { sql } = shared;
    shared = null;
    await sql.end({ timeout: 5 });
  };

  /**
   * Opens what `work` builds on a use of the pool, and hands the use back when `work` throws: the
   * stores whose `close` would release it never reach the caller.
   */
  const using = async <T>(work: (connection: Connection) => Promise<T>): Promise<T> => {
    const connection = open();
    try {
      return await work(connection);
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
  };

  const scopes: Readonly<Record<SchemaScopeName, SchemaScope>> = {
    storage: postgresqlStorageScope({ schema, tables }),
    checkpoints: postgresqlCheckpointsScope(tables.checkpoints),
    "forget-ledger": postgresqlForgetLedgerScope(tables.forgetLedger),
  };
  // A use of the pool for one call, handed back whatever the call does.
  const briefly = async <T>(work: (connection: Connection) => Promise<T>): Promise<T> => {
    const connection = open();
    try {
      return await work(connection);
    } finally {
      await release();
    }
  };
  const versionsOn = (db: PostgresqlDatabase) =>
    readPostgresqlSchemaVersions({ db, prefix: tablePrefix, scopes: Object.values(scopes) });

  return {
    kind: "bounda-adapter",
    name: "postgresql",
    options,
    schemaVersions: () => briefly(({ db }) => versionsOn(db)),
    migrate: (names) =>
      briefly(async ({ db }) => {
        await migratePostgresql({
          db,
          schema,
          prefix: tablePrefix,
          scopes: names.map((scope) => scopes[scope]),
        });
        return versionsOn(db);
      }),
    createStorage: () =>
      using(async ({ db, sql }) => {
        await migratePostgresql({
          db,
          schema,
          prefix: tablePrefix,
          scopes: [
            postgresqlStorageScope({ schema, tables }),
            postgresqlCheckpointsScope(tables.checkpoints),
          ],
        });
        const storesOver = (database: PostgresqlDatabase): StorageTransaction => ({
          eventStore: createPostgresqlEventStore({
            db: database,
            table: tables.events,
            lockKey: tables.appendLockKey,
            channel: tables.channel,
            personalKeys: tables.personalKeys,
            persons: tables.persons,
          }),
          inboxLedger: createPostgresqlInboxLedger({ db: database, table: tables.inbox }),
          deadLetterStore: createPostgresqlDeadLetterStore({
            db: database,
            table: tables.deadLetters,
          }),
          scheduler: createPostgresqlScheduler({ db: database, table: tables.scheduledCommands }),
          idempotencyStore: createPostgresqlIdempotencyStore({
            db: database,
            table: tables.idempotencyKeys,
            personalKeys: tables.personalKeys,
          }),
          personalKeys: createSqlPersonalKeyStore({
            dialect: postgresqlDialect,
            db: database,
            table: tables.personalKeys,
            persons: tables.persons,
          }),
          persons: createSqlPersonStore({
            dialect: postgresqlDialect,
            db: database,
            table: tables.persons,
          }),
          snapshotStore: createPostgresqlSnapshotStore({
            db: database,
            table: tables.snapshots,
            personalKeys: tables.personalKeys,
          }),
        });
        const boundTo = (tx: SqlTransaction): PostgresqlDatabase => ({
          run: tx.run,
          all: tx.all,
          write: (work) => work(tx),
        });
        return {
          ...storesOver(db),
          notifier: createPostgresqlEventNotifier({ sql, channel: tables.channel }),
          checkpointStore: createSqlCheckpointStore({
            db,
            table: tables.checkpoints,
            dialect: postgresqlDialect,
          }),
          subscriberFailures: createSqlSubscriberFailureStore({
            db,
            table: tables.subscriberFailures,
            dialect: postgresqlDialect,
          }),
          // The append lock comes first, before any row the work may lock: two transactions that
          // took the lock and a row in opposite orders would deadlock.
          transact: (work) =>
            db.write(async (tx) => {
              await tx.run("SELECT pg_advisory_xact_lock(hashtext($1))", [tables.appendLockKey]);
              return work(storesOver(boundTo(tx)));
            }),
          close: release,
        };
      }),
    createReadModel: <Row extends object>({ name, fields, logger }: CreateReadModelArgs) =>
      using(async ({ db, sql }) => {
        return openPostgresqlReadModel<Row>({
          db,
          sql,
          schema,
          tablePrefix,
          checkpoints: tables.checkpoints,
          checkpointsLockKey: tables.checkpointsLockKey,
          name,
          fields,
          logger,
          close: release,
        });
      }),
    rebuildReadModel: <Row extends object>({
      name,
      fields,
      logger,
      progress,
    }: CreateReadModelRebuildArgs) =>
      using(async ({ db, sql }) => {
        return rebuildPostgresqlReadModel<Row>({
          db,
          sql,
          schema,
          tablePrefix,
          checkpoints: tables.checkpoints,
          checkpointsLockKey: tables.checkpointsLockKey,
          name,
          fields,
          logger,
          close: release,
          progress,
        });
      }),
    inspect: () =>
      using(async ({ db }) => {
        const names = await db.all(
          `SELECT "table_name" FROM information_schema.tables WHERE "table_schema" = $1 AND "table_type" = 'BASE TABLE' ORDER BY "table_name"`,
          [schema],
        );
        const inspected = [];
        for (const { table_name: name } of names) {
          const table = String(name);
          if (!table.startsWith(tablePrefix)) continue;
          const key = await db.all(
            `SELECT k."column_name" FROM information_schema.table_constraints c JOIN information_schema.key_column_usage k ON k."constraint_schema" = c."constraint_schema" AND k."constraint_name" = c."constraint_name" WHERE c."table_schema" = $1 AND c."table_name" = $2 AND c."constraint_type" = 'PRIMARY KEY' ORDER BY k."ordinal_position"`,
            [schema, table],
          );
          inspected.push(
            await inspectSqlTable({
              db,
              prefix: tablePrefix,
              name: table,
              from: `${quoteName(schema)}.${quoteName(table)}`,
              key: key.map(({ column_name: column }) => String(column)),
            }),
          );
        }
        await release();
        return inspected;
      }),
    createForgetLedger: async ({ tenant }) => {
      const { db } = open();
      return createSqlForgetLedger({
        db,
        table: tables.forgetLedger,
        dialect: postgresqlDialect,
        tenant,
        ensureSchema: () =>
          migratePostgresql({
            db,
            schema,
            prefix: tablePrefix,
            scopes: [postgresqlForgetLedgerScope(tables.forgetLedger)],
          }),
        close: release,
      });
    },
  };
};

export type { PostgresqlOptions } from "./options.ts";
