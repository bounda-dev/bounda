import { resolveConfig } from "../config/schema.ts";
import type { Config } from "../config/types.ts";
import type { AppEnv } from "../register/index.ts";
import { withEncryptedFiles } from "./personal-data/encrypted-files.ts";
import { databasesOf, type SchemaStatus, schemaOf } from "./status.ts";

export interface MigrateTablesArgs {
  readonly config: Config;
  /**
   * The environment the key wrapper and the tenant key store read, such as `process.env`: a
   * database file encrypted under the tenant's keys opens with them. Defaults to none.
   */
  readonly env?: AppEnv;
  /**
   * The tenant whose databases to migrate. Defaults to `DEFAULT_TENANT`.
   */
  readonly tenant?: string;
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
 * nothing to migrate. A database file encrypted under the tenant's keys opens with them, and one
 * in the clear is encrypted first.
 */
export const migrateTables: MigrateTablesFunction = ({ config, env = {}, tenant }) =>
  withEncryptedFiles({
    config,
    env,
    ...(tenant === undefined ? {} : { tenant }),
    work: async (keyed) => {
      const migrated: SchemaStatus[] = [];
      for (const database of databasesOf(resolveConfig(keyed))) {
        migrated.push(...schemaOf(database, await database.adapter.migrate(database.scopes)));
      }
      return migrated;
    },
  });
