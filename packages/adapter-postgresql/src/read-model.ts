import type { FieldsRecord, Logger } from "@bounda-dev/core";
import type { ReadModelPorts } from "@bounda-dev/core/adapter";
import {
  columnsOf,
  createSqlReadClient,
  createSqlTable,
  createTableStatements,
  evolveTableStatements,
  postgresqlDialect,
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
