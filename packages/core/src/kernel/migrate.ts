import { resolveConfig } from "../config/schema.ts";
import type { Config } from "../config/types.ts";
import { databasesOf, type SchemaStatus, schemaOf } from "./status.ts";

export interface MigrateTablesArgs {
  readonly config: Config;
}

export interface MigrateTablesFunction {
  (args: MigrateTablesArgs): Promise<readonly SchemaStatus[]>;
}

/**
 * Brings Bounda's tables to the latest version of this release in every database the
 * configuration names, as an app starting there would, and resolves to the versions after, by
 * database: what `bounda migrate` runs before a deploy, so the instances that start find the
 * tables migrated. Each database migrates under its own lock, one after the other; one that
 * fails stops the rest. Rejects with `StorageSchemaTooNewError` for tables a newer release
 * migrated, writing nothing to that database. An adapter without tables, as `memory()`, has
 * nothing to migrate.
 */
export const migrateTables: MigrateTablesFunction = async ({ config }) => {
  const migrated: SchemaStatus[] = [];
  for (const database of databasesOf(resolveConfig(config))) {
    migrated.push(...schemaOf(database, await database.adapter.migrate(database.scopes)));
  }
  return migrated;
};
