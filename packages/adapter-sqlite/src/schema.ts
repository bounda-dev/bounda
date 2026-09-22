import { quoteIdentifier, tableNameFor } from "@bounda-dev/core/adapter/sql";
import type { SqliteDatabase } from "./database.ts";

/**
 * The quoted names of the five storage tables for a table prefix.
 */
export interface StorageTables {
  readonly events: string;
  readonly checkpoints: string;
  readonly inbox: string;
  readonly deadLetters: string;
  readonly scheduledCommands: string;
}

export interface StorageTablesForFunction {
  (prefix: string): StorageTables;
}

export const storageTablesFor: StorageTablesForFunction = (prefix) => ({
  events: quoteIdentifier(tableNameFor({ prefix, readModel: "events" })),
  checkpoints: quoteIdentifier(tableNameFor({ prefix, readModel: "checkpoints" })),
  inbox: quoteIdentifier(tableNameFor({ prefix, readModel: "inbox" })),
  deadLetters: quoteIdentifier(tableNameFor({ prefix, readModel: "deadLetters" })),
  scheduledCommands: quoteIdentifier(tableNameFor({ prefix, readModel: "scheduledCommands" })),
});

const indexName = (table: string, suffix: string): string =>
  quoteIdentifier(`${table.slice(1, -1)}_${suffix}_idx`);

export interface StorageSchemaStatementsFunction {
  (tables: StorageTables): readonly string[];
}

/**
 * DDL for the write side. `position` is `INTEGER PRIMARY KEY AUTOINCREMENT`: SQLite's single
 * writer makes the global order match commit order, so no extra lock is needed.
 */
export const storageSchemaStatements: StorageSchemaStatementsFunction = (tables) => [
  `CREATE TABLE IF NOT EXISTS ${tables.events} (
    "position" INTEGER PRIMARY KEY AUTOINCREMENT,
    "id" TEXT NOT NULL UNIQUE,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "metadata" TEXT NOT NULL,
    UNIQUE ("aggregate_type", "aggregate_id", "version")
  )`,
  `CREATE TABLE IF NOT EXISTS ${tables.checkpoints} (
    "subscriber" TEXT PRIMARY KEY,
    "position" INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${tables.inbox} (
    "subscriber" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "claimed_at" TEXT NOT NULL,
    "last_error" TEXT,
    PRIMARY KEY ("subscriber", "event_id")
  )`,
  `CREATE TABLE IF NOT EXISTS ${tables.deadLetters} (
    "id" TEXT PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "subscriber" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "error_type" TEXT NOT NULL,
    "error_message" TEXT NOT NULL,
    "error_stack" TEXT,
    "attempts" INTEGER NOT NULL,
    "first_failed_at" TEXT NOT NULL,
    "last_failed_at" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "status")} ON ${tables.deadLetters} ("status")`,
  `CREATE TABLE IF NOT EXISTS ${tables.scheduledCommands} (
    "dedupe_key" TEXT PRIMARY KEY,
    "command_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "execute_at" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "claimed_at" TEXT,
    "last_error" TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.scheduledCommands, "execute_at")} ON ${tables.scheduledCommands} ("execute_at")`,
];

export interface EnsureStorageSchemaArgs {
  readonly db: SqliteDatabase;
  readonly tables: StorageTables;
}

export interface EnsureStorageSchemaFunction {
  (args: EnsureStorageSchemaArgs): Promise<void>;
}

export interface StorageSchemaAdditionsArgs {
  readonly tables: StorageTables;
  /**
   * The columns the dead-letters table has, from `PRAGMA table_info`.
   */
  readonly deadLetterColumns: readonly string[];
}

export interface StorageSchemaAdditionsFunction {
  (args: StorageSchemaAdditionsArgs): readonly string[];
}

/**
 * Columns added to the storage tables after their first release, for databases created before.
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the caller says which columns exist.
 */
export const storageSchemaAdditions: StorageSchemaAdditionsFunction = ({
  tables,
  deadLetterColumns,
}) =>
  deadLetterColumns.includes("payload")
    ? []
    : [`ALTER TABLE ${tables.deadLetters} ADD COLUMN "payload" TEXT`];

/**
 * Creates the storage tables that do not exist yet and adds the columns a table created by an
 * earlier version lacks.
 */
export const ensureStorageSchema: EnsureStorageSchemaFunction = async ({ db, tables }) => {
  for (const statement of storageSchemaStatements(tables)) await db.run(statement, []);
  const deadLetterColumns = (await db.all(`PRAGMA table_info(${tables.deadLetters})`, [])).map(
    (column) => String(column.name),
  );
  for (const statement of storageSchemaAdditions({ tables, deadLetterColumns })) {
    await db.run(statement, []);
  }
};
