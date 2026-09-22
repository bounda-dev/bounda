import type { FieldsRecord, Logger } from "@bounda-dev/core";
import type { ReadModelPorts, ReadModelRebuild } from "@bounda-dev/core/adapter";
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
} from "@bounda-dev/core/adapter/sql";
import type { Client } from "@libsql/client";
import type { SqliteDatabase } from "./database.ts";

export interface OpenSqliteReadModelArgs {
  readonly db: SqliteDatabase;
  readonly client: Client;
  readonly tablePrefix: string;
  readonly name: string;
  readonly fields: FieldsRecord;
  readonly logger: Logger;
  readonly close: () => Promise<void>;
}

export interface OpenSqliteReadModelFunction {
  <Row extends object>(args: OpenSqliteReadModelArgs): Promise<ReadModelPorts<Row, Client>>;
}

/**
 * Creates the read model's table from its `fields`, or brings an existing table up to date with
 * additive changes, then returns the typed table and the SQL read client (`raw` is the libSQL
 * client).
 */
export const openSqliteReadModel: OpenSqliteReadModelFunction = async <Row extends object>({
  db,
  client,
  tablePrefix,
  name,
  fields,
  logger,
  close,
}: OpenSqliteReadModelArgs): Promise<ReadModelPorts<Row, Client>> => {
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
  return {
    table: createSqlTable<Row>({
      readModel: name,
      table,
      fields,
      dialect: sqliteDialect,
      executor: db,
    }),
    client: createSqlReadClient<Row, Client>({
      readModel: name,
      fields,
      dialect: sqliteDialect,
      executor: db,
      raw: client,
    }),
    close,
  };
};

export interface RebuildSqliteReadModelFunction {
  <Row extends object>(args: OpenSqliteReadModelArgs): Promise<ReadModelRebuild<Row, Client>>;
}

const tableExists = async (db: SqliteDatabase, table: string): Promise<boolean> =>
  (await db.all(`PRAGMA table_info(${quoteIdentifier(table)})`, [])).length > 0;

/**
 * Opens the shadow table of a rebuild: `<table>__rebuild`, created fresh with the current fields
 * after dropping what an interrupted rebuild may have left. `commit` swaps it into place inside
 * one write transaction; `abort` drops it. Both release the connection.
 */
export const rebuildSqliteReadModel: RebuildSqliteReadModelFunction = async <Row extends object>({
  db,
  client,
  tablePrefix,
  name,
  fields,
  logger,
  close,
}: OpenSqliteReadModelArgs): Promise<ReadModelRebuild<Row, Client>> => {
  const table = tableNameFor({ prefix: tablePrefix, readModel: name });
  const { shadow } = rebuildTablesFor(table);
  const columns = columnsOf({ readModel: name, fields, dialect: sqliteDialect });
  for (const statement of shadowTableStatements({ table, columns })) await db.run(statement, []);
  logger.info("read model rebuild started", { readModel: name, table, shadow });
  return {
    table: createSqlTable<Row>({
      readModel: name,
      table: shadow,
      fields,
      dialect: sqliteDialect,
      executor: db,
    }),
    client: createSqlReadClient<Row, Client>({
      readModel: name,
      fields,
      dialect: sqliteDialect,
      executor: db,
      raw: client,
    }),
    commit: async () => {
      const live = await tableExists(db, table);
      await db.write(async (tx) => {
        for (const statement of swapTableStatements({ table, columns, live })) {
          await tx.run(statement, []);
        }
      });
      logger.info("read model rebuild committed", { readModel: name, table });
      await close();
    },
    abort: async () => {
      for (const statement of dropShadowTableStatements(table)) await db.run(statement, []);
      logger.info("read model rebuild aborted", { readModel: name, table });
      await close();
    },
  };
};
