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

export interface OpenPostgresqlReadModelArgs {
  readonly db: PostgresqlDatabase;
  readonly sql: Sql;
  readonly schema: string;
  readonly tablePrefix: string;
  /**
   * The quoted name of the checkpoints table the read model's projections advance in.
   */
  readonly checkpoints: string;
  readonly name: string;
  readonly fields: FieldsRecord;
  readonly logger: Logger;
  readonly close: () => Promise<void>;
}

export interface OpenPostgresqlReadModelFunction {
  <Row extends object>(args: OpenPostgresqlReadModelArgs): Promise<ReadModelPorts<Row, Sql>>;
}

/**
 * Creates the read model's table from its `fields`, or brings an existing table up to date with
 * additive changes, then returns the typed table and the SQL read client (`raw` is the
 * Postgres.js client). The checkpoints table is created too when missing, so a read model in a
 * database of its own keeps its projections' checkpoints there.
 *
 * `transact` opens a transaction and takes `pg_advisory_xact_lock` on two keys, the checkpoints
 * table and the subscriber, both through `hashtext`: two-key locks never collide with the
 * one-key lock appends take, and the lock is released with the transaction, however it ends,
 * so a crashed process never leaves it behind. With `wait` false it tries
 * `pg_try_advisory_xact_lock` and gives up when another session holds it. Inside, `client.raw`
 * is the Postgres.js `TransactionSql`, so hand-written SQL joins the transaction.
 */
export const openPostgresqlReadModel: OpenPostgresqlReadModelFunction = async <Row extends object>({
  db,
  sql,
  schema,
  tablePrefix,
  checkpoints,
  name,
  fields,
  logger,
  close,
}: OpenPostgresqlReadModelArgs): Promise<ReadModelPorts<Row, Sql>> => {
  const table = tableNameFor({ prefix: tablePrefix, readModel: name });
  const columns = columnsOf({ readModel: name, fields, dialect: postgresqlDialect });
  const existing = (
    await db.all(
      `SELECT "column_name", "data_type" FROM information_schema.columns WHERE "table_schema" = $1 AND "table_name" = $2 ORDER BY "ordinal_position"`,
      [schema, table],
    )
  ).map((column) => ({ name: String(column.column_name), sqlType: String(column.data_type) }));
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
        const keys = [checkpoints, subscriber];
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
 * Opens the shadow table of a rebuild: `<table>__rebuild`, reopened as it is when `progress`
 * says a paused rebuild got somewhere, created fresh with the current fields otherwise, after
 * dropping what an interrupted rebuild may have left. Opening is one transaction that takes the
 * rebuild's advisory lock and claims the next rebuild generation (see `rebuildFencing`); every
 * later step is one more transaction that takes the same lock and goes ahead only while that
 * generation is still the latest. Each `transact` writes the shadow and the checkpoints. `commit`
 * takes the projections' advisory lock first, as `transact` on the live read model does, then the
 * rebuild's, and swaps the shadow into place, sets the projections' checkpoint and forgets
 * `progress`; `abort` drops the shadow and forgets `progress`, or does nothing when another
 * rebuild took over; `pause` leaves everything. All three release the pool.
 */
export const rebuildPostgresqlReadModel: RebuildPostgresqlReadModelFunction = async <
  Row extends object,
>({
  db,
  sql,
  schema,
  tablePrefix,
  checkpoints,
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
    executor.run("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [checkpoints, key]);
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
      await close();
    },
    abort: async () => {
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
      await close();
    },
    pause: async () => {
      logger.info("read model rebuild paused", { readModel: name, table });
      await close();
    },
  };
};
