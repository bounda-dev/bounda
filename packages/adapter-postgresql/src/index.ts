import type { Adapter, CreateReadModelArgs } from "@bounda-dev/core/adapter";
import { quoteIdentifier } from "@bounda-dev/core/adapter/sql";
import postgres, { type Sql } from "postgres";
import { createPostgresqlCheckpointStore } from "./checkpoint-store.ts";
import { createPostgresqlDatabase, type PostgresqlDatabase } from "./database.ts";
import { createPostgresqlDeadLetterStore } from "./dead-letter-store.ts";
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

  return {
    kind: "bounda-adapter",
    name: "postgresql",
    options,
    createStorage: async () => {
      const { db } = open();
      const tables = storageTablesFor(tablePrefix);
      await ensureStorageSchema({ db, schema, tables });
      return {
        eventStore: createPostgresqlEventStore({
          db,
          table: tables.events,
          lockKey: tables.appendLockKey,
        }),
        checkpointStore: createPostgresqlCheckpointStore({ db, table: tables.checkpoints }),
        inboxLedger: createPostgresqlInboxLedger({ db, table: tables.inbox }),
        deadLetterStore: createPostgresqlDeadLetterStore({ db, table: tables.deadLetters }),
        scheduler: createPostgresqlScheduler({ db, table: tables.scheduledCommands }),
        close: release,
      };
    },
    createReadModel: async <Row extends object>({ name, fields, logger }: CreateReadModelArgs) => {
      const { db, sql } = open();
      await db.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`, []);
      return openPostgresqlReadModel<Row>({
        db,
        sql,
        schema,
        tablePrefix,
        name,
        fields,
        logger,
        close: release,
      });
    },
    rebuildReadModel: async <Row extends object>({ name, fields, logger }: CreateReadModelArgs) => {
      const { db, sql } = open();
      await db.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`, []);
      return rebuildPostgresqlReadModel<Row>({
        db,
        sql,
        schema,
        tablePrefix,
        name,
        fields,
        logger,
        close: release,
      });
    },
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
