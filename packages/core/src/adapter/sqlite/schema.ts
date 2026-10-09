import type { SqlDatabase } from "../sql/database.ts";
import { quoteIdentifier, storageTableNameFor } from "../sql/index.ts";

// Every name is already quoted.
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
  events: quoteIdentifier(storageTableNameFor({ prefix, table: "events" })),
  checkpoints: quoteIdentifier(storageTableNameFor({ prefix, table: "checkpoints" })),
  inbox: quoteIdentifier(storageTableNameFor({ prefix, table: "inbox" })),
  deadLetters: quoteIdentifier(storageTableNameFor({ prefix, table: "deadLetters" })),
  scheduledCommands: quoteIdentifier(storageTableNameFor({ prefix, table: "scheduledCommands" })),
});

const indexName = (table: string, suffix: string): string =>
  quoteIdentifier(`${table.slice(1, -1)}_${suffix}_idx`);

export interface CheckpointTableStatementFunction {
  (table: string): string;
}

/**
 * Apart from the storage schema because a read model in a database of its own needs it too.
 */
export const checkpointTableStatement: CheckpointTableStatementFunction = (table) =>
  `CREATE TABLE IF NOT EXISTS ${table} (
    "subscriber" TEXT PRIMARY KEY,
    "position" INTEGER NOT NULL
  )`;

export interface StorageSchemaStatementsFunction {
  (tables: StorageTables): readonly string[];
}

// SQLite's single writer makes the `AUTOINCREMENT` order of `position` match commit order, so no
// extra lock is needed.
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
  checkpointTableStatement(tables.checkpoints),
  `CREATE TABLE IF NOT EXISTS ${tables.inbox} (
    "handler" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "claimed_at" TEXT NOT NULL,
    "claim_id" TEXT,
    "last_error" TEXT,
    PRIMARY KEY ("handler", "event_id")
  )`,
  `CREATE TABLE IF NOT EXISTS ${tables.deadLetters} (
    "id" TEXT PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "handler" TEXT NOT NULL,
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
    "last_error" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "claim_id" TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.scheduledCommands, "execute_at")} ON ${tables.scheduledCommands} ("execute_at")`,
];

export interface EnsureStorageSchemaArgs {
  readonly db: SqlDatabase;
  readonly tables: StorageTables;
}

export interface EnsureStorageSchemaFunction {
  (args: EnsureStorageSchemaArgs): Promise<void>;
}

export const ensureStorageSchema: EnsureStorageSchemaFunction = async ({ db, tables }) => {
  for (const statement of storageSchemaStatements(tables)) await db.run(statement, []);
};
