import { RebuildSupersededError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { FieldsRecord } from "../../modules/view.ts";
import type { ReadModelPorts, ReadModelRebuild } from "../index.ts";
import { rebuildFencing } from "../rebuild-fencing.ts";
import type { SqlDatabase } from "../sql/database.ts";
import {
  columnsOf,
  createSqlReadClient,
  createSqlTable,
  createTableStatements,
  dropShadowTableStatements,
  evolveTableStatements,
  quoteIdentifier,
  rebuildTablesFor,
  shadowTableStatements,
  sqliteDialect,
  swapTableStatements,
  tableNameFor,
} from "../sql/index.ts";
import type { SqlExecutor } from "../sql/sql-table.ts";
import { createSqliteCheckpointStore } from "./checkpoint-store.ts";
import { checkpointTableStatement } from "./schema.ts";

export interface OpenSqliteReadModelArgs<Raw = unknown> {
  readonly db: SqlDatabase;
  /**
   * The driver handle queries get as `client.raw`.
   */
  readonly raw: Raw;
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

export interface OpenSqliteReadModelFunction {
  <Row extends object, Raw = unknown>(
    args: OpenSqliteReadModelArgs<Raw>,
  ): Promise<ReadModelPorts<Row, Raw>>;
}

/**
 * Creates the read model's table from its `fields`, or brings an existing table up to date with
 * additive changes, then returns the typed table and the SQL read client (`raw` is whatever the
 * host passes). The checkpoints table is created too when missing, so a read model in a database
 * of its own keeps its projections' checkpoints there. `transact` runs the work in one write
 * transaction: SQLite has a single writer, so holding it is the lock and `wait` changes nothing.
 * Inside, `client.raw` is the host's transaction handle.
 */
export const openSqliteReadModel: OpenSqliteReadModelFunction = async <
  Row extends object,
  Raw = unknown,
>({
  db,
  raw,
  tablePrefix,
  checkpoints,
  name,
  fields,
  logger,
  close,
}: OpenSqliteReadModelArgs<Raw>): Promise<ReadModelPorts<Row, Raw>> => {
  const table = tableNameFor({ prefix: tablePrefix, readModel: name });
  const columns = columnsOf({ readModel: name, fields, dialect: sqliteDialect });
  const existing = (await db.all(`PRAGMA table_info(${quoteIdentifier(table)})`, [])).map(
    (column) => ({ name: String(column.name), sqlType: String(column.type) }),
  );
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
      dialect: sqliteDialect,
      executor: db,
    }),
    client: createSqlReadClient<Row, Raw>({
      readModel: name,
      fields,
      dialect: sqliteDialect,
      executor: db,
      raw,
    }),
    checkpointStore: createSqliteCheckpointStore({ db, table: checkpoints }),
    transact: ({ work }) =>
      db.write(async (tx) => ({
        acquired: true,
        value: await work({
          table: createSqlTable<Row>({
            readModel: name,
            table,
            fields,
            dialect: sqliteDialect,
            executor: tx,
          }),
          client: createSqlReadClient<Row, unknown>({
            readModel: name,
            fields,
            dialect: sqliteDialect,
            executor: tx,
            raw: tx.raw,
          }),
          checkpointStore: createSqliteCheckpointStore({ db: tx, table: checkpoints }),
        }),
      })),
    close,
  };
};

export interface RebuildSqliteReadModelArgs<Raw = unknown> extends OpenSqliteReadModelArgs<Raw> {
  /**
   * The checkpoint the rebuild keeps its position under.
   */
  readonly progress: string;
}

export interface RebuildSqliteReadModelFunction {
  <Row extends object, Raw = unknown>(
    args: RebuildSqliteReadModelArgs<Raw>,
  ): Promise<ReadModelRebuild<Row, Raw>>;
}

const tableExists = async (db: SqlExecutor, table: string): Promise<boolean> =>
  (await db.all(`PRAGMA table_info(${quoteIdentifier(table)})`, [])).length > 0;

/**
 * Opens the shadow table of a rebuild: `<table>__rebuild`, reopened as it is when `progress`
 * says a paused rebuild got somewhere, created fresh with the current fields otherwise, after
 * dropping what an interrupted rebuild may have left. Opening is one write transaction that also
 * claims the next rebuild generation (see `rebuildFencing`); every later step is one more write
 * transaction that goes ahead only while that generation is still the latest. Each `transact`
 * writes the shadow and the checkpoints; `commit` swaps the shadow into place, sets the
 * projections' checkpoint and forgets `progress`; `abort` drops the shadow and forgets `progress`,
 * or does nothing when another rebuild took over; `pause` leaves everything. SQLite's single
 * writer is the lock. All three release the connection.
 */
export const rebuildSqliteReadModel: RebuildSqliteReadModelFunction = async <
  Row extends object,
  Raw = unknown,
>({
  db,
  raw,
  tablePrefix,
  checkpoints,
  progress,
  name,
  fields,
  logger,
  close,
}: RebuildSqliteReadModelArgs<Raw>): Promise<ReadModelRebuild<Row, Raw>> => {
  const table = tableNameFor({ prefix: tablePrefix, readModel: name });
  const { shadow } = rebuildTablesFor(table);
  const columns = columnsOf({ readModel: name, fields, dialect: sqliteDialect });
  const fencing = rebuildFencing(name);
  const checkpointsIn = (executor: SqlExecutor) =>
    createSqliteCheckpointStore({ db: executor, table: checkpoints });
  await db.run(checkpointTableStatement(checkpoints), []);
  const opened = await db.write(async (tx) => {
    const store = checkpointsIn(tx);
    const generation = (await store.get(fencing.generation)) + 1;
    await store.set(fencing.generation, generation);
    const saved = await store.get(progress);
    const resumed = saved > 0 && (await tableExists(tx, shadow));
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
  const current = async (executor: SqlExecutor): Promise<boolean> =>
    (await checkpointsIn(executor).get(fencing.generation)) === opened.generation;
  const fenced = async (executor: SqlExecutor): Promise<void> => {
    if (!(await current(executor))) throw new RebuildSupersededError(name);
  };
  const shadowTable = (executor: SqlExecutor) =>
    createSqlTable<Row>({
      readModel: name,
      table: shadow,
      fields,
      dialect: sqliteDialect,
      executor,
    });
  return {
    resumed: opened.resumed,
    position: opened.position,
    table: shadowTable(db),
    client: createSqlReadClient<Row, Raw>({
      readModel: name,
      fields,
      dialect: sqliteDialect,
      executor: db,
      raw,
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
            dialect: sqliteDialect,
            executor: tx,
            raw: tx.raw,
          }),
          checkpointStore: checkpointsIn(tx),
        });
      }),
    commit: async ({ subscriber, position }) => {
      await db.write(async (tx) => {
        await fenced(tx);
        const live = await tableExists(tx, table);
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
