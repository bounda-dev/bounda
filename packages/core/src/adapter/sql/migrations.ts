import { StorageSchemaTooNewError } from "../../contracts/errors.ts";
import type { SchemaVersion } from "../adapter.ts";
import { runInOrder, type SqlTransaction } from "./database.ts";
import type { SqlDialect } from "./dialect.ts";
import { quoteIdentifier, storageTableNameFor } from "./identifiers.ts";
import type { SqlFragment } from "./query-builder.ts";
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
 * A scope's tables as its last migration leaves them, which a database new to the scope gets in
 * one pass instead of every migration in turn.
 */
export interface LatestSchema {
  // Quoted. Every table the scope holds: a database holding none of them is new to it.
  readonly tables: readonly string[];
  readonly statements: readonly string[];
}

/**
 * Tables versioned together. Each lives in whatever database holds it: the storage's, a read
 * models' database of their own, a forget ledger's.
 */
export interface SchemaScope {
  readonly scope: string;
  // Numbered from 1 with no gaps, in order: the version a database is at counts those it applied.
  readonly migrations: readonly SchemaMigration[];
  // The same tables as `migrations` leave them, which `latestSchemaContract` holds on every engine.
  readonly latest: LatestSchema;
}

/**
 * The scopes Bounda versions, as `bounda_migrations` names them: the storage tables, the
 * checkpoints, apart because read models in a database of their own keep them there too, a
 * forget ledger's table and a tenant key store's, wherever they live.
 */
export const SCHEMA_SCOPES = {
  storage: "storage",
  checkpoints: "checkpoints",
  forgetLedger: "forget-ledger",
  tenantKeys: "tenant-keys",
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
 * What `replaySchemas` brings forward, and how the engine reads, locks and reports a missing
 * table.
 */
export interface ReplaySchemasArgs {
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

export interface ReplaySchemasFunction {
  (args: ReplaySchemasArgs): Promise<void>;
}

/**
 * What `migrateSchemas` brings forward: what `replaySchemas` takes, and how the engine lists its
 * tables.
 */
export interface MigrateSchemasArgs extends ReplaySchemasArgs {
  // Unquoted: the tables of the database, or of the PostgreSQL schema, the scopes live in.
  readonly tablesIn: (executor: SqlExecutor) => Promise<ReadonlySet<string>>;
}

export interface MigrateSchemasFunction {
  (args: MigrateSchemasArgs): Promise<void>;
}

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

interface Behind {
  readonly schema: SchemaScope;
  readonly at: number;
}

const versionOf = (versions: ReadonlyMap<string, number>, schema: SchemaScope): number => {
  const version = versions.get(schema.scope) ?? 0;
  const supported = schema.migrations.length;
  if (version > supported) {
    throw new StorageSchemaTooNewError({ scope: schema.scope, version, supported });
  }
  return version;
};

// Throws before anything is written when a scope is past what this version knows.
const behindIn = (
  versions: ReadonlyMap<string, number>,
  scopes: readonly SchemaScope[],
): readonly Behind[] =>
  scopes
    .map((schema) => ({ schema, at: versionOf(versions, schema) }))
    .filter(({ schema, at }) => at < schema.migrations.length);

const insertVersion = (table: string, dialect: SqlDialect): string =>
  `INSERT INTO ${table} ("scope", "version", "applied_at") VALUES (${dialect.placeholder(1)}, ${dialect.placeholder(2)}, ${dialect.placeholder(3)})`;

// What a Durable Object's SQLite binds to one statement at most.
const DURABLE_OBJECT_PARAMETERS = 100;
const VERSIONS_PER_INSERT = Math.floor(DURABLE_OBJECT_PARAMETERS / 3);

// Every version of `scopes`, recorded as applied at `appliedAt`, in as few statements as fit.
const insertVersions = (
  table: string,
  dialect: SqlDialect,
  scopes: readonly SchemaScope[],
  appliedAt: string,
): readonly SqlFragment[] => {
  const rows = scopes.flatMap((schema) =>
    schema.migrations.map(({ version }) => [schema.scope, version, appliedAt]),
  );
  const statements: SqlFragment[] = [];
  for (let start = 0; start < rows.length; start += VERSIONS_PER_INSERT) {
    const chunk = rows.slice(start, start + VERSIONS_PER_INSERT);
    const values = chunk.map(
      (_, row) =>
        `(${[1, 2, 3].map((column) => dialect.placeholder(row * 3 + column)).join(", ")})`,
    );
    statements.push({
      sql: `INSERT INTO ${table} ("scope", "version", "applied_at") VALUES ${values.join(", ")}`,
      params: chunk.flat(),
    });
  }
  return statements;
};

// Each migration in a transaction of its own, after reading the version again under the lock, so
// instances starting together apply each once and a failure keeps the ones before it.
const replay = async (
  { dialect, table, locked, isMissingTable, now = () => new Date() }: ReplaySchemasArgs,
  behind: readonly Behind[],
): Promise<void> => {
  for (const { schema, at } of behind) {
    let version = at;
    while (version < schema.migrations.length) {
      version = await locked(async (tx) => {
        await tx.run(schemaMigrationsTableStatement(table), []);
        const current = versionOf(await versionsIn(tx, table, isMissingTable), schema);
        const migration = schema.migrations[current];
        if (migration === undefined) return current;
        await migration.migrate(tx);
        await tx.run(insertVersion(table, dialect), [
          schema.scope,
          migration.version,
          now().toISOString(),
        ]);
        return migration.version;
      });
    }
  }
};

/**
 * Brings every scope to its latest version one migration at a time, as a database an earlier
 * version left behind is. A database already there costs one read and takes no lock, so running
 * instances never wait on one that starts. Throws `StorageSchemaTooNewError`, before writing
 * anything, when a scope is past what it knows.
 */
export const replaySchemas: ReplaySchemasFunction = async (args) => {
  await replay(
    args,
    behindIn(await versionsIn(args.db, args.table, args.isMissingTable), args.scopes),
  );
};

// The items before the first that `keep` refuses.
const leading = <T>(items: readonly T[], keep: (item: T) => boolean): readonly T[] => {
  const end = items.findIndex((item) => !keep(item));
  return end === -1 ? items : items.slice(0, end);
};

/**
 * `replaySchemas`, except that the scopes a database is new to, unversioned and holding none of
 * their tables, are created as they stand at their latest version and recorded at it, in a single
 * transaction whose statements go to the database together. Scopes keep their order: one that
 * fails leaves the ones after it untouched.
 */
export const migrateSchemas: MigrateSchemasFunction = async (args) => {
  const { db, dialect, table, locked, isMissingTable, tablesIn } = args;
  const now = args.now ?? (() => new Date());
  const unquoted = (name: string): string => name.slice(1, -1);
  // Creates the leading run of `candidates` the database is new to and says how many it created;
  // under the lock, as another instance may have created or versioned them meanwhile.
  const createLeading = (candidates: readonly SchemaScope[]): Promise<number> =>
    locked(async (tx) => {
      const present = await tablesIn(tx);
      const versions = present.has(unquoted(table))
        ? await versionsIn(tx, table, isMissingTable)
        : new Map<string, number>();
      const isNew = (schema: SchemaScope): boolean =>
        versionOf(versions, schema) === 0 &&
        !schema.latest.tables.some((name) => present.has(unquoted(name)));
      const fresh = leading(candidates, isNew);
      const appliedAt = now().toISOString();
      await runInOrder(
        tx,
        fresh.length === 0
          ? []
          : [
              { sql: schemaMigrationsTableStatement(table), params: [] },
              ...fresh.flatMap((schema) =>
                schema.latest.statements.map((sql) => ({ sql, params: [] })),
              ),
              ...insertVersions(table, dialect, fresh, appliedAt),
            ],
      );
      return fresh.length;
    });
  let pending = behindIn(await versionsIn(db, table, isMissingTable), args.scopes);
  while (pending.length > 0) {
    const unversioned = leading(pending, ({ at }) => at === 0);
    const created =
      unversioned.length === 0 ? 0 : await createLeading(unversioned.map(({ schema }) => schema));
    if (created === 0) await replay(args, pending.slice(0, 1));
    pending = pending.slice(Math.max(created, 1));
  }
};
