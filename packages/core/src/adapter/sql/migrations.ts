import { StorageSchemaTooNewError } from "../../contracts/errors.ts";
import type { SchemaVersion } from "../adapter.ts";
import type { SqlTransaction } from "./database.ts";
import type { SqlDialect } from "./dialect.ts";
import { quoteIdentifier, storageTableNameFor } from "./identifiers.ts";
import type { SqlExecutor } from "./sql-table.ts";

/**
 * One step forward of a scope's tables. It runs in a transaction that also records its version,
 * so it is applied whole or not at all, and it must be idempotent: an unversioned database may
 * already hold part of what it creates.
 */
export interface SchemaMigration {
  readonly version: number;
  readonly migrate: (tx: SqlTransaction) => Promise<void>;
}

/**
 * Tables versioned together. Each lives in whatever database holds it: the storage's, a read
 * models' database of their own, a forget ledger's.
 */
export interface SchemaScope {
  readonly scope: string;
  // Numbered from 1 with no gaps, in order: the version a database is at counts those it applied.
  readonly migrations: readonly SchemaMigration[];
}

/**
 * The scopes Bounda versions, as `bounda_migrations` names them: the storage tables, the
 * checkpoints, apart because read models in a database of their own keep them there too, and a
 * forget ledger's table, wherever it lives.
 */
export const SCHEMA_SCOPES = {
  storage: "storage",
  checkpoints: "checkpoints",
  forgetLedger: "forget-ledger",
} as const;

export const SCHEMA_MIGRATIONS_TABLE = "migrations";

export interface SchemaMigrationsTableForFunction {
  (prefix: string): string;
}

/**
 * The quoted table that records the versions of a table prefix: `<prefix>migrations`.
 */
export const schemaMigrationsTableFor: SchemaMigrationsTableForFunction = (prefix) =>
  quoteIdentifier(storageTableNameFor({ prefix, table: SCHEMA_MIGRATIONS_TABLE }));

export interface SchemaMigrationsTableStatementFunction {
  (table: string): string;
}

// One row per version applied, so the table also says when each came in.
export const schemaMigrationsTableStatement: SchemaMigrationsTableStatementFunction = (table) =>
  `CREATE TABLE IF NOT EXISTS ${table} (
    "scope" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "applied_at" TEXT NOT NULL,
    PRIMARY KEY ("scope", "version")
  )`;

/**
 * What `migrateSchemas` brings forward, and how the engine reads, locks and reports a missing
 * table.
 */
export interface MigrateSchemasArgs {
  readonly db: SqlExecutor;
  readonly dialect: SqlDialect;
  // Quoted.
  readonly table: string;
  readonly scopes: readonly SchemaScope[];
  /**
   * Runs `work` in a write transaction that holds the database's schema lock, waiting for it as
   * long as it takes: whoever holds it is migrating the same tables.
   */
  readonly locked: <T>(work: (tx: SqlTransaction) => Promise<T>) => Promise<T>;
  readonly isMissingTable: (error: unknown) => boolean;
  readonly now?: () => Date;
}

export interface MigrateSchemasFunction {
  (args: MigrateSchemasArgs): Promise<void>;
}

/**
 * Brings every scope to its latest version. A database already there costs one read and takes no
 * lock, so running instances never wait on one that starts. Otherwise each pending migration runs
 * in a transaction of its own under the lock, after reading the versions again: instances starting
 * together apply each migration once, and one that fails leaves the ones before it applied.
 * Throws `StorageSchemaTooNewError`, before writing anything, when a scope is past what it knows.
 */
const versionsIn = async (
  executor: SqlExecutor,
  table: string,
  isMissingTable: (error: unknown) => boolean,
): Promise<ReadonlyMap<string, number>> => {
  try {
    const rows = await executor.all(
      `SELECT "scope", max("version") AS "version" FROM ${table} GROUP BY "scope"`,
      [],
    );
    return new Map(rows.map((row) => [String(row.scope), Number(row.version)]));
  } catch (error) {
    if (isMissingTable(error)) return new Map();
    throw error;
  }
};

export interface ReadSchemaVersionsArgs {
  readonly db: SqlExecutor;
  // Quoted.
  readonly table: string;
  readonly scopes: readonly SchemaScope[];
  readonly isMissingTable: (error: unknown) => boolean;
}

export interface ReadSchemaVersionsFunction {
  (args: ReadSchemaVersionsArgs): Promise<readonly SchemaVersion[]>;
}

/**
 * The version each scope is at, `0` for one never migrated, beside its latest: one read, no lock.
 */
export const readSchemaVersions: ReadSchemaVersionsFunction = async ({
  db,
  table,
  scopes,
  isMissingTable,
}) => {
  const found = await versionsIn(db, table, isMissingTable);
  return scopes.map(({ scope, migrations }) => ({
    scope,
    version: found.get(scope) ?? 0,
    latest: migrations.length,
  }));
};

export const migrateSchemas: MigrateSchemasFunction = async ({
  db,
  dialect,
  table,
  scopes,
  locked,
  isMissingTable,
  now = () => new Date(),
}) => {
  const p = dialect.placeholder;
  const versionOf = (versions: ReadonlyMap<string, number>, schema: SchemaScope): number => {
    const version = versions.get(schema.scope) ?? 0;
    const supported = schema.migrations.length;
    if (version > supported) {
      throw new StorageSchemaTooNewError({ scope: schema.scope, version, supported });
    }
    return version;
  };
  const found = await versionsIn(db, table, isMissingTable);
  const behind = scopes.map((schema) => ({ schema, at: versionOf(found, schema) }));
  for (const { schema, at } of behind) {
    for (const migration of schema.migrations.slice(at)) {
      await locked(async (tx) => {
        await tx.run(schemaMigrationsTableStatement(table), []);
        if (migration.version <= versionOf(await versionsIn(tx, table, isMissingTable), schema))
          return;
        await migration.migrate(tx);
        await tx.run(
          `INSERT INTO ${table} ("scope", "version", "applied_at") VALUES (${p(1)}, ${p(2)}, ${p(3)})`,
          [schema.scope, migration.version, now().toISOString()],
        );
      });
    }
  }
};
