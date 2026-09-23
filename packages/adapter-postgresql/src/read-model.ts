import type { FieldsRecord, Logger } from "@bounda-dev/core";
import type { ReadModelPorts, ReadModelRebuild } from "@bounda-dev/core/adapter";
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

const tableExists = async (
  db: PostgresqlDatabase,
  schema: string,
  table: string,
): Promise<boolean> =>
  (
    await db.all(
      `SELECT 1 FROM information_schema.tables WHERE "table_schema" = $1 AND "table_name" = $2`,
      [schema, table],
    )
  ).length > 0;

/**
 * Opens the shadow table of a rebuild: `<table>__rebuild`, reopened as it is when `progress`
 * says a paused rebuild got somewhere, created fresh with the current fields otherwise, after
 * dropping what an interrupted rebuild may have left. Each `transact` is one transaction on the
 * shadow and the checkpoints. `commit` takes the projections' advisory lock, as `transact` on the
 * live read model does, then swaps the shadow into place, sets their checkpoint and forgets
 * `progress` in the same transaction; `abort` drops the shadow and forgets `progress`, `pause`
 * leaves both. All three release the pool.
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
  await db.run(checkpointTableStatement(checkpoints), []);
  const checkpointStore = createPostgresqlCheckpointStore({ db, table: checkpoints });
  const saved = await checkpointStore.get(progress);
  const resumed = saved > 0 && (await tableExists(db, schema, shadow));
  if (!resumed) {
    for (const statement of shadowTableStatements({ table, columns })) await db.run(statement, []);
    await checkpointStore.remove(progress);
  }
  logger.info(resumed ? "read model rebuild resumed" : "read model rebuild started", {
    readModel: name,
    table,
    shadow,
  });
  const shadowTable = (executor: SqlExecutor) =>
    createSqlTable<Row>({
      readModel: name,
      table: shadow,
      fields,
      dialect: postgresqlDialect,
      executor,
    });
  return {
    resumed,
    position: resumed ? saved : 0,
    table: shadowTable(db),
    client: createSqlReadClient<Row, Sql>({
      readModel: name,
      fields,
      dialect: postgresqlDialect,
      executor: db,
      raw: sql,
    }),
    checkpointStore,
    transact: (work) =>
      db.write((tx) =>
        work({
          table: shadowTable(tx),
          client: createSqlReadClient<Row, unknown>({
            readModel: name,
            fields,
            dialect: postgresqlDialect,
            executor: tx,
            raw: tx.raw,
          }),
          checkpointStore: createPostgresqlCheckpointStore({ db: tx, table: checkpoints }),
        }),
      ),
    commit: async ({ subscriber, position }) => {
      const live = await tableExists(db, schema, table);
      await db.write(async (tx) => {
        await tx.run("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
          checkpoints,
          subscriber,
        ]);
        for (const statement of swapTableStatements({ table, columns, live })) {
          await tx.run(statement, []);
        }
        const committed = createPostgresqlCheckpointStore({ db: tx, table: checkpoints });
        await committed.set(subscriber, position);
        await committed.remove(progress);
      });
      logger.info("read model rebuild committed", { readModel: name, table });
      await close();
    },
    abort: async () => {
      for (const statement of dropShadowTableStatements(table)) await db.run(statement, []);
      await checkpointStore.remove(progress);
      logger.info("read model rebuild aborted", { readModel: name, table });
      await close();
    },
    pause: async () => {
      logger.info("read model rebuild paused", { readModel: name, table });
      await close();
    },
  };
};
