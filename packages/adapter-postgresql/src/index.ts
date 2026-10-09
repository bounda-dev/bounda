import type {
  Adapter,
  CreateReadModelArgs,
  CreateReadModelRebuildArgs,
  StorageTransaction,
} from "@bounda-dev/core/adapter";
import { quoteIdentifier, type SqlTransaction } from "@bounda-dev/core/adapter/sql";
import postgres, { type Sql } from "postgres";
import { createPostgresqlCheckpointStore } from "./checkpoint-store.ts";
import { createPostgresqlDatabase, type PostgresqlDatabase } from "./database.ts";
import { createPostgresqlDeadLetterStore } from "./dead-letter-store.ts";
import { createPostgresqlEventNotifier } from "./event-notifier.ts";
import { createPostgresqlEventStore } from "./event-store.ts";
import { createPostgresqlInboxLedger } from "./inbox-ledger.ts";
import { type PostgresqlOptions, resolvePostgresqlOptions } from "./options.ts";
import { openPostgresqlReadModel, rebuildPostgresqlReadModel } from "./read-model.ts";
import { createPostgresqlScheduler } from "./scheduler.ts";
import { ensureStorageSchema, storageTablesFor } from "./schema.ts";

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
   * ports whose `close` would release it never reach the caller.
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

  return {
    kind: "bounda-adapter",
    name: "postgresql",
    options,
    createStorage: () =>
      using(async ({ db, sql }) => {
        const tables = storageTablesFor(tablePrefix);
        await ensureStorageSchema({ db, schema, tables });
        const storesOver = (database: PostgresqlDatabase): StorageTransaction => ({
          eventStore: createPostgresqlEventStore({
            db: database,
            table: tables.events,
            lockKey: tables.appendLockKey,
            channel: tables.channel,
          }),
          inboxLedger: createPostgresqlInboxLedger({ db: database, table: tables.inbox }),
          deadLetterStore: createPostgresqlDeadLetterStore({
            db: database,
            table: tables.deadLetters,
          }),
          scheduler: createPostgresqlScheduler({ db: database, table: tables.scheduledCommands }),
        });
        const boundTo = (tx: SqlTransaction): PostgresqlDatabase => ({
          run: tx.run,
          all: tx.all,
          write: (work) => work(tx),
        });
        return {
          ...storesOver(db),
          notifier: createPostgresqlEventNotifier({ sql, channel: tables.channel }),
          checkpointStore: createPostgresqlCheckpointStore({ db, table: tables.checkpoints }),
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
        await db.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`, []);
        return openPostgresqlReadModel<Row>({
          db,
          sql,
          schema,
          tablePrefix,
          checkpoints: storageTablesFor(tablePrefix).checkpoints,
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
        await db.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`, []);
        return rebuildPostgresqlReadModel<Row>({
          db,
          sql,
          schema,
          tablePrefix,
          checkpoints: storageTablesFor(tablePrefix).checkpoints,
          name,
          fields,
          logger,
          close: release,
          progress,
        });
      }),
  };
};

export type { PostgresqlDatabase } from "./database.ts";
export type {
  PostgresqlLocation,
  PostgresqlOptions,
  ResolvedPostgresqlOptions,
} from "./options.ts";
export {
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_SCHEMA,
  DEFAULT_TABLE_PREFIX,
  resolvePostgresqlOptions,
} from "./options.ts";
export type { StorageTables } from "./schema.ts";
export { storageSchemaStatements, storageTablesFor } from "./schema.ts";
