import { ConfigurationError } from "@bounda-dev/core";
import {
  forgetLedgerCategoriesStatement,
  forgetLedgerStatements,
  migrateSchemas,
  postgresqlDialect,
  quoteIdentifier,
  resolvedAtOfEarlierLetters,
  SCHEMA_SCOPES,
  type SchemaScope,
  type SqlExecutor,
  type SqlTransaction,
  schemaMigrationsTableFor,
} from "@bounda-dev/core/adapter/sql";
import type { PostgresqlDatabase } from "./database.ts";
import {
  checkpointTableStatement,
  inSchema,
  type StorageTables,
  storageSchemaStatements,
} from "./schema.ts";

type StorageTable = Exclude<
  keyof StorageTables,
  "forgetLedger" | "appendLockKey" | "checkpointsLockKey" | "channel"
>;

interface AddedColumn {
  readonly table: StorageTable;
  readonly column: string;
  readonly definition: string;
}

// Every column a table gained after Bounda 0.2.0 created it, the oldest version whose tables the
// first migration takes in.
const ADDED_COLUMNS: readonly AddedColumn[] = [
  { table: "events", column: "person", definition: "text" },
  { table: "deadLetters", column: "person", definition: "text" },
  { table: "deadLetters", column: "error_name", definition: "text NOT NULL DEFAULT ''" },
  { table: "deadLetters", column: "error_code", definition: "text" },
  { table: "deadLetters", column: "resolved_at", definition: "text" },
  { table: "deadLetters", column: "persons", definition: "jsonb NOT NULL DEFAULT '[]'" },
  { table: "scheduledCommands", column: "persons", definition: "jsonb NOT NULL DEFAULT '[]'" },
  { table: "personalKeys", column: "kid", definition: "text" },
  { table: "personalKeys", column: "held_until", definition: "text" },
  { table: "personalKeys", column: "attempts", definition: "integer NOT NULL DEFAULT 0" },
  { table: "persons", column: "restricted_since", definition: "text" },
  { table: "persons", column: "position", definition: "bigint NOT NULL DEFAULT 0" },
  { table: "persons", column: "last_active_at", definition: "text" },
  { table: "persons", column: "forgotten_at", definition: "text" },
  { table: "persons", column: "held_until", definition: "text" },
  { table: "persons", column: "attempts", definition: "integer NOT NULL DEFAULT 0" },
];

// Rows written before errors were named. A letter kept its text unencoded: it is named after the
// first line of its stack, `Error` without one, and its text encoded as `encodeErrorText` does.
// System events carried the text, which may quote a person, where they now name the error, and
// claims kept it in the clear as their last error.
const unquotedErrorsStatements = (tables: StorageTables): readonly string[] => [
  `UPDATE ${tables.deadLetters} SET "error_name" = coalesce(substring(split_part(coalesce("error_stack", ''), E'\\n', 1) from '^([A-Za-z_$][A-Za-z0-9_$]*)(?::|\\r?$)'), 'Error'), "error_message" = to_jsonb("error_message")::text, "error_stack" = to_jsonb("error_stack")::text`,
  // A table created now has no default there: every letter names its error.
  `ALTER TABLE ${tables.deadLetters} ALTER COLUMN "error_name" DROP DEFAULT`,
  `UPDATE ${tables.events} AS "failed" SET "payload" = ("payload" - 'error') || jsonb_build_object('errorName', coalesce((SELECT "error_name" FROM ${tables.deadLetters} WHERE "id" = "failed"."payload"->>'letterId'), 'Error')) WHERE "type" = 'ProcessFailed' AND starts_with("aggregate_type", 'process:') AND "payload"->'error' IS NOT NULL`,
  `UPDATE ${tables.events} SET "payload" = ("payload" - 'error') || '{"errorName":"Error"}'::jsonb WHERE "type" = 'ScheduledCommandFailed' AND ("metadata"->>'system')::boolean IS TRUE AND "payload"->'error' IS NOT NULL`,
  `UPDATE ${tables.inbox} SET "last_error" = NULL WHERE "last_error" IS NOT NULL`,
  `UPDATE ${tables.scheduledCommands} SET "last_error" = NULL WHERE "last_error" IS NOT NULL`,
];

// A forgetting recorded before it named its person and its reason, which could only be a request.
const earlierForgettingsStatements = (tables: StorageTables): readonly string[] => [
  `UPDATE ${tables.events} SET "person" = "aggregate_id" WHERE "aggregate_type" = 'bounda' AND "type" = 'PersonalDataForgotten' AND "person" IS NULL`,
  `UPDATE ${tables.events} SET "payload" = "payload" || '{"reason":"requested"}'::jsonb WHERE "aggregate_type" = 'bounda' AND "type" = 'PersonalDataForgotten' AND "payload"->'reason' IS NULL`,
];

const columnsOf = async (
  tx: SqlExecutor,
  schema: string,
  table: string,
): Promise<ReadonlySet<string>> =>
  new Set(
    (
      await tx.all(
        `SELECT "column_name" FROM information_schema.columns WHERE "table_schema" = $1 AND "table_name" = $2`,
        [schema, table.slice(1, -1)],
      )
    ).map((column) => String(column.column_name)),
  );

/**
 * The first migration: creates the storage tables, or takes in those an unversioned schema holds,
 * created by any version from 0.2.0 on, with the columns they lack and what those columns would
 * have held.
 */
const adoptStorageTables = async (
  tx: SqlTransaction,
  schema: string,
  tables: StorageTables,
): Promise<void> => {
  if ((await columnsOf(tx, schema, tables.inbox)).has("subscriber")) {
    throw new ConfigurationError(
      `The Bounda tables of schema "${schema}" were created by a version before 0.2.0, which already had to be created again from 0.2.0 on; create them again`,
    );
  }
  const added = new Set<AddedColumn>();
  for (const name of new Set(ADDED_COLUMNS.map(({ table }) => table))) {
    const existing = await columnsOf(tx, schema, tables[name]);
    if (existing.size === 0) continue;
    for (const column of ADDED_COLUMNS) {
      if (column.table !== name || existing.has(column.column)) continue;
      await tx.run(
        `ALTER TABLE ${tables[name]} ADD COLUMN "${column.column}" ${column.definition}`,
        [],
      );
      added.add(column);
    }
  }
  const gained = (table: StorageTable, name: string): boolean =>
    [...added].some(({ table: of, column }) => of === table && column === name);
  if (gained("deadLetters", "error_name")) {
    for (const statement of unquotedErrorsStatements(tables)) await tx.run(statement, []);
  }
  if (gained("deadLetters", "resolved_at")) {
    await tx.run(resolvedAtOfEarlierLetters(tables.deadLetters), []);
  }
  if ((await columnsOf(tx, schema, tables.events)).size > 0) {
    for (const statement of earlierForgettingsStatements(tables)) await tx.run(statement, []);
  }
  // Superseded by the listing index.
  await tx.run(
    `DROP INDEX IF EXISTS ${quoteIdentifier(`${tables.deadLetters.slice(1, -1)}_status_idx`)}`,
    [],
  );
  for (const statement of storageSchemaStatements(tables)) await tx.run(statement, []);
};

const keysIndex = (tables: StorageTables, suffix: string): string =>
  quoteIdentifier(`${tables.personalKeys.slice(1, -1)}_${suffix}_idx`);

/**
 * The second migration: a key per person and category instead of one per person, each named by
 * its fingerprint, with the person's last activity on it and whether a forgetting kept it under a
 * legal obligation. Every key there was is the person's key in the default category, last active
 * when the person was, unless they were forgotten after that, when the key came later. Every
 * forgetting recorded before forgot the person as a whole, in the default category.
 */
const adoptCategories = async (
  tx: SqlTransaction,
  schema: string,
  tables: StorageTables,
): Promise<void> => {
  const keys = tables.personalKeys;
  const forgettings = `UPDATE ${tables.events} SET "payload" = "payload" || '{"categories":["default"],"retained":[],"whole":true}'::jsonb WHERE "aggregate_type" = 'bounda' AND "type" = 'PersonalDataForgotten' AND "payload"->'categories' IS NULL`;
  // A schema migrated before, whose versions were lost, has the keys as this leaves them.
  if ((await columnsOf(tx, schema, keys)).has("category")) {
    await tx.run(forgettings, []);
    return;
  }
  const [primary] = await tx.all(
    `SELECT "constraint_name" FROM information_schema.table_constraints WHERE "table_schema" = $1 AND "table_name" = $2 AND "constraint_type" = 'PRIMARY KEY'`,
    [schema, keys.slice(1, -1)],
  );
  const statements = [
    `ALTER TABLE ${keys} ADD COLUMN "category" text NOT NULL DEFAULT 'default', ADD COLUMN "last_active_at" text, ADD COLUMN "retained_since" text, ADD COLUMN "forget_held_until" text, ADD COLUMN "forget_attempts" integer NOT NULL DEFAULT 0`,
    `ALTER TABLE ${keys} ALTER COLUMN "category" DROP DEFAULT`,
    ...(primary === undefined
      ? []
      : [
          `ALTER TABLE ${keys} DROP CONSTRAINT ${quoteIdentifier(String(primary.constraint_name))}`,
        ]),
    `ALTER TABLE ${keys} ADD PRIMARY KEY ("person", "fingerprint")`,
    `UPDATE ${keys} AS "k" SET "last_active_at" = "p"."last_active_at" FROM ${tables.persons} AS "p" WHERE "p"."person" = "k"."person" AND "p"."forgotten_at" IS NULL`,
    // One key in force per person and category, which `add` resolves its race on.
    `CREATE UNIQUE INDEX ${keysIndex(tables, "in_force")} ON ${keys} ("person", "category") WHERE "retained_since" IS NULL`,
    // What a category's retention reads, least recently active first.
    `CREATE INDEX ${keysIndex(tables, "due")} ON ${keys} ("category", "last_active_at") WHERE "last_active_at" IS NOT NULL`,
    forgettings,
  ];
  for (const statement of statements) await tx.run(statement, []);
};

export interface PostgresqlStorageScopeArgs {
  readonly schema: string;
  readonly tables: StorageTables;
}

export interface PostgresqlStorageScopeFunction {
  (args: PostgresqlStorageScopeArgs): SchemaScope;
}

export const postgresqlStorageScope: PostgresqlStorageScopeFunction = ({ schema, tables }) => ({
  scope: SCHEMA_SCOPES.storage,
  migrations: [
    { version: 1, migrate: (tx) => adoptStorageTables(tx, schema, tables) },
    { version: 2, migrate: (tx) => adoptCategories(tx, schema, tables) },
  ],
});

export interface PostgresqlCheckpointsScopeFunction {
  (table: string): SchemaScope;
}

export const postgresqlCheckpointsScope: PostgresqlCheckpointsScopeFunction = (table) => ({
  scope: SCHEMA_SCOPES.checkpoints,
  migrations: [{ version: 1, migrate: (tx) => tx.run(checkpointTableStatement(table), []) }],
});

export interface PostgresqlForgetLedgerScopeFunction {
  (table: string): SchemaScope;
}

export const postgresqlForgetLedgerScope: PostgresqlForgetLedgerScopeFunction = (table) => ({
  scope: SCHEMA_SCOPES.forgetLedger,
  migrations: [
    {
      version: 1,
      migrate: async (tx) => {
        for (const statement of forgetLedgerStatements(table, postgresqlDialect)) {
          await tx.run(statement, []);
        }
      },
    },
    {
      version: 2,
      migrate: (tx) => tx.run(forgetLedgerCategoriesStatement(table, postgresqlDialect), []),
    },
  ],
});

// PostgreSQL's `undefined_table`.
const UNDEFINED_TABLE = "42P01";

export interface MigratePostgresqlArgs {
  readonly db: PostgresqlDatabase;
  readonly schema: string;
  readonly prefix: string;
  readonly scopes: readonly SchemaScope[];
}

export interface MigratePostgresqlFunction {
  (args: MigratePostgresqlArgs): Promise<void>;
}

/**
 * `migrateSchemas` in a schema, under the schema's advisory lock, which the read models' changes
 * to their tables take too.
 */
export const migratePostgresql: MigratePostgresqlFunction = ({ db, schema, prefix, scopes }) =>
  migrateSchemas({
    db,
    dialect: postgresqlDialect,
    table: schemaMigrationsTableFor(prefix),
    scopes,
    locked: (work) => inSchema({ db, schema, work }),
    isMissingTable: (error) =>
      error instanceof Error && Reflect.get(error, "code") === UNDEFINED_TABLE,
  });
