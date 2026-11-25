import { ConfigurationError } from "../../contracts/errors.ts";
import type { SchemaScopeName } from "../adapter.ts";
import type { SqlDatabase, SqlTransaction } from "../sql/database.ts";
import { resolvedAtOfEarlierLetters } from "../sql/dead-letters.ts";
import { sqliteDialect } from "../sql/dialect.ts";
import {
  forgetLedgerCategoriesStatement,
  forgetLedgerCommittedStatement,
  forgetLedgerDefaultTenantStatements,
  forgetLedgerDisclosureStatement,
  forgetLedgerFenceStatement,
  forgetLedgerLatestSchema,
  forgetLedgerMarksStatement,
  forgetLedgerReachedStatement,
  forgetLedgerReasonStatements,
  forgetLedgerRedactionStatement,
  forgetLedgerRestrictionStatement,
  forgetLedgerStatements,
} from "../sql/forget-ledger.ts";
import { quoteIdentifier, storageTableNameFor } from "../sql/identifiers.ts";
import { indexKeysTableStatement } from "../sql/index-key-store.ts";
import {
  type MigrateSchemasArgs,
  migrateSchemas,
  replaySchemas,
  SCHEMA_SCOPES,
  type SchemaScope,
  schemaMigrationsTableFor,
} from "../sql/migrations.ts";
import { supersededKeysTableStatements } from "../sql/personal-key-store.ts";
import { recipientTablesStatements } from "../sql/recipient-store.ts";
import type { SqlExecutor } from "../sql/sql-table.ts";
import { tenancyTableStatement } from "../sql/tenancy-store.ts";
import { tenantFenceTableStatement } from "../sql/tenant-fence.ts";
import { tenantKeysTableStatement } from "../sql/tenant-key-store.ts";
import {
  checkpointTableStatement,
  deadLetterReadsStatements,
  latestStorageTablesStatements,
  personalKeysIndexStatements,
  personalKeysTableStatement,
  personRowsBackfillStatements,
  restrictedPersonsTableStatements,
  restrictionStatements,
  type StorageTables,
  statePersonIndexStatement,
  storageSchemaStatements,
  storageTablesFor,
  subscriberFailuresTableStatement,
} from "./schema.ts";
import { busyRetryDelay, pause } from "./wal.ts";

interface AddedColumn {
  readonly table: keyof StorageTables;
  readonly column: string;
  // As `ADD COLUMN` takes it: a column `NOT NULL` needs a default there.
  readonly definition: string;
}

// Every column a table gained after Bounda 0.2.0 created it, the oldest version whose tables the
// first migration takes in.
// The columns migration 9 adds: when a scheduled command was scheduled, and the person a process
// letter's instance state names. Rows stored before hold neither.
const NINTH_COLUMNS: readonly AddedColumn[] = [
  { table: "scheduledCommands", column: "scheduled_at", definition: "TEXT" },
  { table: "deadLetters", column: "state_person", definition: "TEXT" },
];

// The columns migration 11 adds: whom else the work behind a dead letter or a subscriber failure
// read data of. Rows stored before name nobody there.
const ELEVENTH_COLUMNS: readonly AddedColumn[] = [
  { table: "deadLetters", column: "read_persons", definition: "TEXT NOT NULL DEFAULT '[]'" },
  {
    table: "subscriberFailures",
    column: "read_persons",
    definition: "TEXT NOT NULL DEFAULT '[]'",
  },
];

const ADDED_COLUMNS: readonly AddedColumn[] = [
  { table: "events", column: "person", definition: "TEXT" },
  { table: "deadLetters", column: "person", definition: "TEXT" },
  { table: "deadLetters", column: "error_name", definition: "TEXT NOT NULL DEFAULT ''" },
  { table: "deadLetters", column: "error_code", definition: "TEXT" },
  { table: "deadLetters", column: "resolved_at", definition: "TEXT" },
  { table: "deadLetters", column: "persons", definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "scheduledCommands", column: "persons", definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "personalKeys", column: "kid", definition: "TEXT" },
  { table: "personalKeys", column: "held_until", definition: "TEXT" },
  { table: "personalKeys", column: "attempts", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "persons", column: "restricted_since", definition: "TEXT" },
  { table: "persons", column: "position", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "persons", column: "last_active_at", definition: "TEXT" },
  { table: "persons", column: "forgotten_at", definition: "TEXT" },
  { table: "persons", column: "held_until", definition: "TEXT" },
  { table: "persons", column: "attempts", definition: "INTEGER NOT NULL DEFAULT 0" },
  ...NINTH_COLUMNS,
  ...ELEVENTH_COLUMNS,
];

// Rows written before errors were named. A letter kept its text unencoded: it is named after the
// first line of its stack, `Error` without one, and its text encoded as `encodeErrorText` does.
// System events carried the text, which may quote a person, where they now name the error, and
// claims kept it in the clear as their last error.
const unquotedErrorsStatements = (tables: StorageTables): readonly string[] => [
  `UPDATE ${tables.deadLetters} SET "error_name" = "named"."name", "error_message" = json_quote(${tables.deadLetters}."error_message"), "error_stack" = CASE WHEN ${tables.deadLetters}."error_stack" IS NULL THEN NULL ELSE json_quote(${tables.deadLetters}."error_stack") END FROM (SELECT "id", CASE WHEN "head" <> '' AND "head" NOT GLOB '*[^A-Za-z0-9_$]*' AND substr("head", 1, 1) NOT GLOB '[0-9]' THEN "head" ELSE 'Error' END AS "name" FROM (SELECT "id", CASE WHEN instr("line", ':') > 0 THEN substr("line", 1, instr("line", ':') - 1) ELSE "line" END AS "head" FROM (SELECT "id", rtrim(substr(coalesce("error_stack", ''), 1, instr(coalesce("error_stack", '') || char(10), char(10)) - 1), char(13)) AS "line" FROM ${tables.deadLetters}))) AS "named" WHERE ${tables.deadLetters}."id" = "named"."id"`,
  `UPDATE ${tables.events} SET "payload" = json_set(json_remove("payload", '$.error'), '$.errorName', coalesce((SELECT "error_name" FROM ${tables.deadLetters} WHERE "id" = json_extract(${tables.events}."payload", '$.letterId')), 'Error')) WHERE "type" = 'ProcessFailed' AND substr("aggregate_type", 1, 8) = 'process:' AND json_type("payload", '$.error') IS NOT NULL`,
  `UPDATE ${tables.events} SET "payload" = json_set(json_remove("payload", '$.error'), '$.errorName', 'Error') WHERE "type" = 'ScheduledCommandFailed' AND json_extract("metadata", '$.system') = 1 AND json_type("payload", '$.error') IS NOT NULL`,
  `UPDATE ${tables.inbox} SET "last_error" = NULL WHERE "last_error" IS NOT NULL`,
  `UPDATE ${tables.scheduledCommands} SET "last_error" = NULL WHERE "last_error" IS NOT NULL`,
];

// A forgetting recorded before it named its person and its reason, which could only be a request.
const earlierForgettingsStatements = (tables: StorageTables): readonly string[] => [
  `UPDATE ${tables.events} SET "person" = "aggregate_id" WHERE "aggregate_type" = 'bounda' AND "type" = 'PersonalDataForgotten' AND "person" IS NULL`,
  `UPDATE ${tables.events} SET "payload" = json_set("payload", '$.reason', 'requested') WHERE "aggregate_type" = 'bounda' AND "type" = 'PersonalDataForgotten' AND json_type("payload", '$.reason') IS NULL`,
];

const columnsOf = async (tx: SqlExecutor, table: string): Promise<ReadonlySet<string>> =>
  new Set((await tx.all(`PRAGMA table_info(${table})`, [])).map((column) => String(column.name)));

/**
 * The first migration: creates the storage tables, or takes in those an unversioned database
 * holds, created by any version from 0.2.0 on, with the columns they lack and what those columns
 * would have held.
 */
const adoptStorageTables = async (tx: SqlTransaction, tables: StorageTables): Promise<void> => {
  if ((await columnsOf(tx, tables.inbox)).has("subscriber")) {
    throw new ConfigurationError(
      "The Bounda tables of this database were created by a version before 0.2.0, which already had to be created again from 0.2.0 on; create the database again",
    );
  }
  const added = new Set<AddedColumn>();
  for (const name of new Set(ADDED_COLUMNS.map(({ table }) => table))) {
    const existing = await columnsOf(tx, tables[name]);
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
  const gained = (table: keyof StorageTables, name: string): boolean =>
    [...added].some(({ table: of, column }) => of === table && column === name);
  if (gained("deadLetters", "error_name")) {
    for (const statement of unquotedErrorsStatements(tables)) await tx.run(statement, []);
  }
  if (gained("deadLetters", "resolved_at")) {
    await tx.run(resolvedAtOfEarlierLetters(tables.deadLetters), []);
  }
  if ((await columnsOf(tx, tables.events)).size > 0) {
    for (const statement of earlierForgettingsStatements(tables)) await tx.run(statement, []);
  }
  // Superseded by the listing index.
  await tx.run(
    `DROP INDEX IF EXISTS ${quoteIdentifier(`${tables.deadLetters.slice(1, -1)}_status_idx`)}`,
    [],
  );
  for (const statement of storageSchemaStatements(tables)) await tx.run(statement, []);
  for (const statement of personRowsBackfillStatements(tables)) await tx.run(statement, []);
};

/**
 * The third migration: a key per person and category instead of one per person, each named by
 * its fingerprint, with the person's last activity on it and whether a forgetting kept it under a
 * legal obligation. Every key there was is the person's key in the default category, last active
 * when the person was, unless they were forgotten after that, when the key came later. Every
 * forgetting recorded before forgot the person as a whole, in the default category.
 */
const adoptCategories = async (tx: SqlTransaction, tables: StorageTables): Promise<void> => {
  const keys = tables.personalKeys;
  const next = quoteIdentifier(`${keys.slice(1, -1)}_next`);
  const forgettings = `UPDATE ${tables.events} SET "payload" = json_set("payload", '$.categories', json('["default"]'), '$.retained', json('[]'), '$.whole', json('true')) WHERE "aggregate_type" = 'bounda' AND "type" = 'PersonalDataForgotten' AND json_type("payload", '$.categories') IS NULL`;
  // A database migrated before, whose versions were lost, has the keys as this leaves them.
  const rebuilt = (await columnsOf(tx, keys)).has("category");
  const statements = [
    personalKeysTableStatement(next),
    `INSERT INTO ${next} ("person", "category", "fingerprint", "key", "kid", "held_until", "attempts", "last_active_at") SELECT "k"."person", 'default', "k"."fingerprint", "k"."key", "k"."kid", "k"."held_until", "k"."attempts", (SELECT "p"."last_active_at" FROM ${tables.persons} AS "p" WHERE "p"."person" = "k"."person" AND "p"."forgotten_at" IS NULL) FROM ${keys} AS "k"`,
    `DROP TABLE ${keys}`,
    `ALTER TABLE ${next} RENAME TO ${keys}`,
    ...personalKeysIndexStatements(tables),
  ];
  for (const statement of rebuilt ? [] : statements) await tx.run(statement, []);
  await tx.run(forgettings, []);
};

export interface SqliteStorageScopeFunction {
  (tables: StorageTables): SchemaScope;
}

export const sqliteStorageScope: SqliteStorageScopeFunction = (tables) => ({
  scope: SCHEMA_SCOPES.storage,
  latest: {
    tables: [
      tables.events,
      tables.inbox,
      tables.deadLetters,
      tables.scheduledCommands,
      tables.idempotencyKeys,
      tables.persons,
      tables.snapshots,
      tables.personRows,
      tables.subscriberFailures,
      tables.personalKeys,
      tables.restrictions,
      tables.indexKeys,
      tables.disclosures,
      tables.recipients,
      tables.tenancy,
      tables.supersededKeys,
    ],
    statements: [
      ...latestStorageTablesStatements(tables),
      indexKeysTableStatement(tables.indexKeys),
      ...recipientTablesStatements(tables),
      tenancyTableStatement(tables.tenancy),
      ...supersededKeysTableStatements(tables.supersededKeys),
    ],
  },
  migrations: [
    { version: 1, migrate: (tx) => adoptStorageTables(tx, tables) },
    {
      version: 2,
      migrate: (tx) => tx.run(subscriberFailuresTableStatement(tables.subscriberFailures), []),
    },
    { version: 3, migrate: (tx) => adoptCategories(tx, tables) },
    {
      version: 4,
      migrate: async (tx) => {
        for (const statement of restrictionStatements(tables)) await tx.run(statement, []);
      },
    },
    { version: 5, migrate: (tx) => tx.run(indexKeysTableStatement(tables.indexKeys), []) },
    {
      version: 6,
      migrate: async (tx) => {
        for (const statement of recipientTablesStatements(tables)) await tx.run(statement, []);
      },
    },
    {
      version: 7,
      migrate: async (tx) => {
        await tx.run(tenancyTableStatement(tables.tenancy), []);
        // Snapshots and remembered rejections are sealed at rest from now on. Those kept in the clear
        // go: a snapshot is only a cache, and a rejection sent again is decided again; a stored
        // result holds ids alone, and stays until it expires.
        await tx.run(`DELETE FROM ${tables.snapshots}`, []);
        await tx.run(
          `DELETE FROM ${tables.idempotencyKeys} WHERE json_type("outcome", '$.rejected') = 'text'`,
          [],
        );
      },
    },
    {
      version: 8,
      migrate: async (tx) => {
        // An answer is sealed whole from now on, the command's fingerprint inside it. One kept
        // before takes its fingerprint in, and is read as it was until it expires.
        if (!(await columnsOf(tx, tables.idempotencyKeys)).has("fingerprint")) return;
        await tx.run(
          `UPDATE ${tables.idempotencyKeys} SET "outcome" = json_object('fingerprint', "fingerprint", 'outcome', json("outcome"))`,
          [],
        );
        await tx.run(`ALTER TABLE ${tables.idempotencyKeys} DROP COLUMN "fingerprint"`, []);
      },
    },
    {
      version: 9,
      migrate: async (tx) => {
        for (const { table, column, definition } of NINTH_COLUMNS) {
          if ((await columnsOf(tx, tables[table])).has(column)) continue;
          await tx.run(`ALTER TABLE ${tables[table]} ADD COLUMN "${column}" ${definition}`, []);
        }
        await tx.run(statePersonIndexStatement(tables), []);
      },
    },
    {
      version: 10,
      migrate: async (tx) => {
        for (const statement of supersededKeysTableStatements(tables.supersededKeys)) {
          await tx.run(statement, []);
        }
      },
    },
    {
      version: 11,
      migrate: async (tx) => {
        for (const { table, column, definition } of ELEVENTH_COLUMNS) {
          if ((await columnsOf(tx, tables[table])).has(column)) continue;
          await tx.run(`ALTER TABLE ${tables[table]} ADD COLUMN "${column}" ${definition}`, []);
        }
        for (const statement of deadLetterReadsStatements(tables)) await tx.run(statement, []);
      },
    },
  ],
});

export interface SqliteCheckpointsScopeFunction {
  (
    tables: Pick<
      StorageTables,
      "checkpoints" | "restrictedPersons" | "restrictedPositions" | "tenantFence"
    >,
  ): SchemaScope;
}

export const sqliteCheckpointsScope: SqliteCheckpointsScopeFunction = (tables) => ({
  scope: SCHEMA_SCOPES.checkpoints,
  latest: {
    tables: [
      tables.checkpoints,
      tables.restrictedPersons,
      tables.restrictedPositions,
      tables.tenantFence,
    ],
    statements: [
      checkpointTableStatement(tables.checkpoints),
      ...restrictedPersonsTableStatements(tables),
      tenantFenceTableStatement(tables.tenantFence),
    ],
  },
  migrations: [
    { version: 1, migrate: (tx) => tx.run(checkpointTableStatement(tables.checkpoints), []) },
    {
      version: 2,
      migrate: async (tx) => {
        for (const statement of restrictedPersonsTableStatements(tables))
          await tx.run(statement, []);
      },
    },
    // What a forgetting kept is told by the key fields of each row now, not by the copy.
    {
      version: 3,
      migrate: (tx) =>
        tx.run(`DELETE FROM ${tables.restrictedPersons} WHERE "source" = 'retained'`, []),
    },
    // Every database that holds the tenant's writes holds their fence.
    { version: 4, migrate: (tx) => tx.run(tenantFenceTableStatement(tables.tenantFence), []) },
    // The handled restore is one row now, whose hash names the position it was handled at.
    {
      version: 5,
      migrate: (tx) =>
        tx.run(
          `DELETE FROM ${tables.checkpoints} WHERE "subscriber" = 'runtime:restore-handled-at'`,
          [],
        ),
    },
  ],
});

export interface SqliteForgetLedgerScopeFunction {
  (table: string): SchemaScope;
}

export const sqliteForgetLedgerScope: SqliteForgetLedgerScopeFunction = (table) => ({
  scope: SCHEMA_SCOPES.forgetLedger,
  latest: forgetLedgerLatestSchema(table, sqliteDialect),
  migrations: [
    {
      version: 1,
      migrate: async (tx) => {
        for (const statement of forgetLedgerStatements(table, sqliteDialect)) {
          await tx.run(statement, []);
        }
      },
    },
    { version: 2, migrate: (tx) => tx.run(forgetLedgerMarksStatement(table), []) },
    {
      version: 3,
      migrate: async (tx) => {
        for (const statement of forgetLedgerReasonStatements(table)) await tx.run(statement, []);
      },
    },
    {
      version: 4,
      migrate: async (tx) => {
        if ((await columnsOf(tx, table)).has("categories")) return;
        await tx.run(forgetLedgerCategoriesStatement(table, sqliteDialect), []);
      },
    },
    {
      version: 5,
      migrate: async (tx) => {
        if ((await columnsOf(tx, table)).has("restriction")) return;
        await tx.run(forgetLedgerRestrictionStatement(table, sqliteDialect), []);
      },
    },
    {
      version: 6,
      migrate: async (tx) => {
        if ((await columnsOf(tx, table)).has("redaction")) return;
        await tx.run(forgetLedgerRedactionStatement(table, sqliteDialect), []);
      },
    },
    {
      version: 7,
      migrate: async (tx) => {
        if ((await columnsOf(tx, table)).has("disclosure")) return;
        await tx.run(forgetLedgerDisclosureStatement(table, sqliteDialect), []);
      },
    },
    { version: 8, migrate: (tx) => tx.run(forgetLedgerFenceStatement(table), []) },
    {
      version: 9,
      migrate: async (tx) => {
        for (const statement of forgetLedgerDefaultTenantStatements(table)) {
          await tx.run(statement, []);
        }
      },
    },
    {
      version: 10,
      migrate: async (tx) => {
        if ((await columnsOf(tx, table)).has("committed")) return;
        await tx.run(forgetLedgerCommittedStatement(table, sqliteDialect), []);
      },
    },
    {
      version: 11,
      migrate: async (tx) => {
        if ((await columnsOf(tx, table)).has("reached")) return;
        await tx.run(forgetLedgerReachedStatement(table, sqliteDialect), []);
      },
    },
  ],
});

export interface SqliteTenantKeysScopeFunction {
  (table: string): SchemaScope;
}

export const sqliteTenantKeysScope: SqliteTenantKeysScopeFunction = (table) => ({
  scope: SCHEMA_SCOPES.tenantKeys,
  latest: { tables: [table], statements: [tenantKeysTableStatement(table)] },
  migrations: [{ version: 1, migrate: (tx) => tx.run(tenantKeysTableStatement(table), []) }],
});

export interface IsMissingSqliteTableFunction {
  (error: unknown): boolean;
}

export const isMissingSqliteTable: IsMissingSqliteTableFunction = (error) =>
  error instanceof Error && /no such table/i.test(error.message);

export interface MigrateSqliteArgs {
  readonly db: SqlDatabase;
  /**
   * Whether an error is the driver's `SQLITE_BUSY`; absent for a connection that is the database's
   * only writer, as a Durable Object's is.
   */
  readonly isBusy?: ((error: unknown) => boolean) | undefined;
  readonly prefix: string;
  readonly scopes: readonly SchemaScope[];
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface MigrateSqliteFunction {
  (args: MigrateSqliteArgs): Promise<void>;
}

const tablesIn = async (executor: SqlExecutor): Promise<ReadonlySet<string>> =>
  new Set(
    (await executor.all(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`, [])).map((row) =>
      String(row.name),
    ),
  );

// SQLite's write transaction is the lock. Another process migrating a large database can hold it
// past the busy timeout, so a busy write is tried again until it runs.
const sqliteArgs = ({
  db,
  isBusy = () => false,
  prefix,
  scopes,
  sleep = pause,
}: MigrateSqliteArgs): MigrateSchemasArgs => ({
  db,
  dialect: sqliteDialect,
  table: schemaMigrationsTableFor(prefix),
  scopes,
  locked: async (work) => {
    for (;;) {
      try {
        return await db.write(work);
      } catch (error) {
        if (!isBusy(error)) throw error;
        await sleep(busyRetryDelay());
      }
    }
  },
  isMissingTable: isMissingSqliteTable,
  tablesIn,
});

/**
 * `migrateSchemas` on SQLite.
 */
export const migrateSqlite: MigrateSqliteFunction = (args) => migrateSchemas(sqliteArgs(args));

/**
 * `replaySchemas` on SQLite, as `migrateSqlite` would bring forward a database an earlier version
 * left behind.
 */
export const replaySqlite: MigrateSqliteFunction = (args) => replaySchemas(sqliteArgs(args));

export interface SqliteSchemaScopesForFunction {
  (prefix: string): Readonly<Record<SchemaScopeName, SchemaScope>>;
}

/**
 * Every scope an adapter's database holds under `prefix`.
 */
export const sqliteSchemaScopesFor: SqliteSchemaScopesForFunction = (prefix) => {
  const tables = storageTablesFor(prefix);
  return {
    storage: sqliteStorageScope(tables),
    checkpoints: sqliteCheckpointsScope(tables),
    "forget-ledger": sqliteForgetLedgerScope(
      quoteIdentifier(storageTableNameFor({ prefix, table: "forgetLedger" })),
    ),
    "tenant-keys": sqliteTenantKeysScope(
      quoteIdentifier(storageTableNameFor({ prefix, table: "tenantKeys" })),
    ),
  };
};
