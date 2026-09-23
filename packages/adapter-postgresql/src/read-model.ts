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
  shadowTableStatements,
  swapTableStatements,
  tableNameFor,
} from "@bounda-dev/core/adapter/sql";
import type { Sql } from "postgres";
import type { PostgresqlDatabase } from "./database.ts";

export interface OpenPostgresqlReadModelArgs {
  readonly db: PostgresqlDatabase;
  readonly sql: Sql;
  readonly schema: string;
  readonly tablePrefix: string;
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
 * Postgres.js client).
 */
export const openPostgresqlReadModel: OpenPostgresqlReadModelFunction = async <Row extends object>({
  db,
  sql,
  schema,
  tablePrefix,
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
    close,
  };
};

export interface RebuildPostgresqlReadModelArgs extends OpenPostgresqlReadModelArgs {
  readonly resume?: boolean;
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
 * Opens the shadow table of a rebuild: `<table>__rebuild`, created fresh with the current fields
 * after dropping what an interrupted rebuild may have left, or reopened as it is with `resume`
 * when it exists. `commit` swaps it into place inside one transaction, `abort` drops it, `pause`
 * leaves it. All three release the pool.
 */
export const rebuildPostgresqlReadModel: RebuildPostgresqlReadModelFunction = async <
  Row extends object,
>({
  db,
  sql,
  schema,
  tablePrefix,
  name,
  fields,
  logger,
  close,
  resume = false,
}: RebuildPostgresqlReadModelArgs): Promise<ReadModelRebuild<Row, Sql>> => {
  const table = tableNameFor({ prefix: tablePrefix, readModel: name });
  const { shadow } = rebuildTablesFor(table);
  const columns = columnsOf({ readModel: name, fields, dialect: postgresqlDialect });
  const resumed = resume && (await tableExists(db, schema, shadow));
  if (!resumed) {
    for (const statement of shadowTableStatements({ table, columns })) await db.run(statement, []);
  }
  logger.info(resumed ? "read model rebuild resumed" : "read model rebuild started", {
    readModel: name,
    table,
    shadow,
  });
  return {
    resumed,
    table: createSqlTable<Row>({
      readModel: name,
      table: shadow,
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
    commit: async () => {
      const live = await tableExists(db, schema, table);
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
    pause: async () => {
      logger.info("read model rebuild paused", { readModel: name, table });
      await close();
    },
  };
};
