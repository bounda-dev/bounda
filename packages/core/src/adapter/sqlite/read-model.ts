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
  type ExistingColumn,
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

const quoteName = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * The table's columns with what its indexes say of them; none when the table does not exist.
 */
const existingColumns = async (
  db: SqlExecutor,
  table: string,
): Promise<readonly ExistingColumn[]> => {
  const quoted = quoteIdentifier(table);
  const columns = await db.all(`PRAGMA table_info(${quoted})`, []);
  if (columns.length === 0) return [];
  const unique = new Set<string>();
  const indexed = new Set<string>();
  for (const index of await db.all(`PRAGMA index_list(${quoted})`, [])) {
    const parts = await db.all(`PRAGMA index_info(${quoteName(String(index.name))})`, []);
    const first = parts.find((part) => Number(part.seqno) === 0);
    if (first === undefined) continue;
    indexed.add(String(first.name));
    if (parts.length === 1 && Number(index.unique) === 1) unique.add(String(first.name));
  }
  return columns.map((column) => {
    const name = String(column.name);
    const primaryKey = Number(column.pk) > 0;
    return {
      name,
      sqlType: String(column.type),
      primaryKey,
      unique: unique.has(name) && !primaryKey,
      indexed: indexed.has(name),
    };
  });
};

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
 * Creates the read model's table from its `fields`, or evolves an existing one additively. The
 * checkpoints table is created too when missing, so a read model in a database of its own keeps
 * its projections' checkpoints there. `transact` is one write transaction: SQLite has a single
 * writer, so holding it is the lock and `wait` changes nothing.
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
  const existing = await existingColumns(db, table);
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
 * `Adapter.rebuildReadModel` over SQLite, fenced by `rebuildFencing`. Opening and every later
 * step are each one write transaction; SQLite's single writer is the lock.
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
      try {
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
