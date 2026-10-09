import { type FieldsRecord, type Logger, RebuildSupersededError } from "@bounda-dev/core";
import {
  type ReadModelPorts,
  type ReadModelRebuild,
  rebuildFencing,
} from "@bounda-dev/core/adapter";
import {
  columnsOf,
  createSqlReadClient,
  createSqlTable,
  createTableStatements,
  dropShadowTableStatements,
  type ExistingColumn,
  evolveTableStatements,
  postgresqlDialect,
  rebuildTablesFor,
  type SqlExecutor,
  shadowTableStatements,
  swapTableStatements,
  tableNameFor,
} from "@bounda-dev/core/adapter/sql";
import type { Sql } from "postgres";
import { createPostgresqlCheckpointStore } from "./checkpoint-store.ts";
import type { PostgresqlDatabase } from "./database.ts";
import { checkpointTableStatement } from "./schema.ts";

/**
 * The table's columns with what its indexes say of them; none when the table does not exist.
 */
const existingColumns = async (
  db: SqlExecutor,
  schema: string,
  table: string,
): Promise<readonly ExistingColumn[]> => {
  const columns = await db.all(
    `SELECT "column_name", "data_type" FROM information_schema.columns WHERE "table_schema" = $1 AND "table_name" = $2 ORDER BY "ordinal_position"`,
    [schema, table],
  );
  if (columns.length === 0) return [];
  const indexes = await db.all(
    `SELECT a.attname AS "column", i.indisprimary AS "primary", i.indisunique AND i.indnatts = 1 AS "unique"
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  );
  const facts = (name: string, fact: "primary" | "unique"): boolean =>
    indexes.some((index) => index.column === name && index[fact] === true);
  return columns.map((column) => {
    const name = String(column.column_name);
    const primaryKey = facts(name, "primary");
    return {
      name,
      sqlType: String(column.data_type),
      primaryKey,
      unique: facts(name, "unique") && !primaryKey,
      indexed: indexes.some((index) => index.column === name),
    };
  });
};

export interface OpenPostgresqlReadModelArgs {
  readonly db: PostgresqlDatabase;
  readonly sql: Sql;
  readonly schema: string;
  readonly tablePrefix: string;
  /**
   * The quoted name of the checkpoints table the read model's projections advance in.
   */
  readonly checkpoints: string;
  /**
   * The first key of the advisory locks taken on the checkpoints table, qualified by its schema.
   */
  readonly checkpointsLockKey: string;
  readonly name: string;
  readonly fields: FieldsRecord;
  readonly logger: Logger;
  readonly close: () => Promise<void>;
}

export interface OpenPostgresqlReadModelFunction {
  <Row extends object>(args: OpenPostgresqlReadModelArgs): Promise<ReadModelPorts<Row, Sql>>;
}

/**
 * The checkpoints table is created too, so a read model in a database of its own keeps its
 * projections' checkpoints there.
 *
 * `transact` locks on two keys, the checkpoints table's and the subscriber: two-key advisory locks
 * never collide with the one-key lock appends take, and a transaction-scoped lock goes with its
 * transaction however it ends, so a crashed process never leaves it behind.
 */
export const openPostgresqlReadModel: OpenPostgresqlReadModelFunction = async <Row extends object>({
  db,
  sql,
  schema,
  tablePrefix,
  checkpoints,
  checkpointsLockKey,
  name,
  fields,
  logger,
  close,
}: OpenPostgresqlReadModelArgs): Promise<ReadModelPorts<Row, Sql>> => {
  const table = tableNameFor({ prefix: tablePrefix, readModel: name });
  const columns = columnsOf({ readModel: name, fields, dialect: postgresqlDialect });
  const existing = await existingColumns(db, schema, table);
  const statements =
    existing.length === 0
      ? createTableStatements({ table, columns })
      : evolveTableStatements({ readModel: name, table, columns, existing });
  for (const statement of statements) await db.run(statement, []);
  if (existing.length > 0 && statements.length > 0) {
    logger.info("read model table evolved", { readModel: name, table, added: statements.length });
  }
  await db.run(checkpointTableStatement(checkpoints), []);
  return {
    table: createSqlTable<Row>({
      readModel: name,
      table,
      fields,
      dialect: postgresqlDialect,
      executor: db,
    }),
    client: createSqlReadClient<Row, Sql>({
      readModel: name,
      fields,
      dialect: postgresqlDialect,
      executor: db,
      raw: sql,
    }),
    checkpointStore: createPostgresqlCheckpointStore({ db, table: checkpoints }),
    transact: ({ subscriber, wait, work }) =>
      db.write(async (tx) => {
        const keys = [checkpointsLockKey, subscriber];
        if (wait) {
          await tx.run("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", keys);
        } else {
          const [lock] = await tx.all(
            `SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS "acquired"`,
            keys,
          );
          if (lock?.acquired !== true) return { acquired: false };
        }
        return {
          acquired: true,
          value: await work({
            table: createSqlTable<Row>({
              readModel: name,
              table,
              fields,
              dialect: postgresqlDialect,
              executor: tx,
            }),
            client: createSqlReadClient<Row, unknown>({
              readModel: name,
              fields,
              dialect: postgresqlDialect,
              executor: tx,
              raw: tx.raw,
            }),
            checkpointStore: createPostgresqlCheckpointStore({ db: tx, table: checkpoints }),
          }),
        };
      }),
    close,
  };
};

export interface RebuildPostgresqlReadModelArgs extends OpenPostgresqlReadModelArgs {
  /**
   * The checkpoint the rebuild keeps its position under.
   */
  readonly progress: string;
}

export interface RebuildPostgresqlReadModelFunction {
  <Row extends object>(args: RebuildPostgresqlReadModelArgs): Promise<ReadModelRebuild<Row, Sql>>;
}

const tableExists = async (db: SqlExecutor, schema: string, table: string): Promise<boolean> =>
  (
    await db.all(
      `SELECT 1 FROM information_schema.tables WHERE "table_schema" = $1 AND "table_name" = $2`,
      [schema, table],
    )
  ).length > 0;

/**
 * Opening claims the next rebuild generation under the rebuild's advisory lock (see
 * `rebuildFencing`); every later step takes the same lock and goes ahead only while that
 * generation is still the latest. `commit` takes the projections' lock before the rebuild's, the
 * one `transact` on the live read model holds, so the swap waits for a projection batch in flight.
 * `commit`, `abort` and `pause` each give up the rebuild's hold on the pool.
 */
export const rebuildPostgresqlReadModel: RebuildPostgresqlReadModelFunction = async <
  Row extends object,
>({
  db,
  sql,
  schema,
  tablePrefix,
  checkpoints,
  checkpointsLockKey,
  progress,
  name,
  fields,
  logger,
  close,
}: RebuildPostgresqlReadModelArgs): Promise<ReadModelRebuild<Row, Sql>> => {
  const table = tableNameFor({ prefix: tablePrefix, readModel: name });
  const { shadow } = rebuildTablesFor(table);
  const columns = columnsOf({ readModel: name, fields, dialect: postgresqlDialect });
  const fencing = rebuildFencing(name);
  const checkpointsIn = (executor: SqlExecutor) =>
    createPostgresqlCheckpointStore({ db: executor, table: checkpoints });
  const lock = (executor: SqlExecutor, key: string) =>
    executor.run("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      checkpointsLockKey,
      key,
    ]);
  await db.run(checkpointTableStatement(checkpoints), []);
  const opened = await db.write(async (tx) => {
    await lock(tx, fencing.lock);
    const store = checkpointsIn(tx);
    const generation = (await store.get(fencing.generation)) + 1;
    await store.set(fencing.generation, generation);
    const saved = await store.get(progress);
    const resumed = saved > 0 && (await tableExists(tx, schema, shadow));
    if (!resumed) {
      for (const statement of shadowTableStatements({ table, columns }))
        await tx.run(statement, []);
      await store.remove(progress);
    }
    return { generation, resumed, position: resumed ? saved : 0 };
  });
  logger.info(opened.resumed ? "read model rebuild resumed" : "read model rebuild started", {
    readModel: name,
    table,
    shadow,
  });
  const current = async (executor: SqlExecutor): Promise<boolean> => {
    await lock(executor, fencing.lock);
    return (await checkpointsIn(executor).get(fencing.generation)) === opened.generation;
  };
  const fenced = async (executor: SqlExecutor): Promise<void> => {
    if (!(await current(executor))) throw new RebuildSupersededError(name);
  };
  const shadowTable = (executor: SqlExecutor) =>
    createSqlTable<Row>({
      readModel: name,
      table: shadow,
      fields,
      dialect: postgresqlDialect,
      executor,
    });
  // The first of commit, abort and pause to run releases the connection, even when it fails.
  let ended = false;
  const end = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    await close();
  };
  return {
    resumed: opened.resumed,
    position: opened.position,
    table: shadowTable(db),
    client: createSqlReadClient<Row, Sql>({
      readModel: name,
      fields,
      dialect: postgresqlDialect,
      executor: db,
      raw: sql,
    }),
    checkpointStore: checkpointsIn(db),
    transact: (work) =>
      db.write(async (tx) => {
        await fenced(tx);
        return work({
          table: shadowTable(tx),
          client: createSqlReadClient<Row, unknown>({
            readModel: name,
            fields,
            dialect: postgresqlDialect,
            executor: tx,
            raw: tx.raw,
          }),
          checkpointStore: checkpointsIn(tx),
        });
      }),
    commit: async ({ subscriber, position }) => {
      try {
        await db.write(async (tx) => {
          await lock(tx, subscriber);
          await fenced(tx);
          const live = await tableExists(tx, schema, table);
          for (const statement of swapTableStatements({ table, columns, live })) {
            await tx.run(statement, []);
          }
          const store = checkpointsIn(tx);
          await store.set(subscriber, position);
          await store.remove(progress);
        });
        logger.info("read model rebuild committed", { readModel: name, table });
      } finally {
        await end();
      }
    },
    abort: async () => {
      try {
        const aborted = await db.write(async (tx) => {
          if (!(await current(tx))) return false;
          for (const statement of dropShadowTableStatements(table)) await tx.run(statement, []);
          const store = checkpointsIn(tx);
          await store.remove(progress);
          return true;
        });
        logger.info(aborted ? "read model rebuild aborted" : "read model rebuild superseded", {
          readModel: name,
          table,
        });
      } finally {
        await end();
      }
    },
    pause: async () => {
      logger.info("read model rebuild paused", { readModel: name, table });
      await end();
    },
  };
};
