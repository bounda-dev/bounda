import type { SqlDatabase } from "../sql/database.ts";
import { quoteIdentifier, storageTableNameFor } from "../sql/index.ts";

// Every name is already quoted.
export interface StorageTables {
  readonly events: string;
  readonly eventTypes: string;
  readonly checkpoints: string;
  readonly inbox: string;
  readonly deadLetters: string;
  readonly scheduledCommands: string;
  readonly idempotencyKeys: string;
  readonly personalKeys: string;
  readonly persons: string;
  readonly snapshots: string;
}

export interface StorageTablesForFunction {
  (prefix: string): StorageTables;
}

export const storageTablesFor: StorageTablesForFunction = (prefix) => ({
  events: quoteIdentifier(storageTableNameFor({ prefix, table: "events" })),
  eventTypes: quoteIdentifier(storageTableNameFor({ prefix, table: "eventTypes" })),
  checkpoints: quoteIdentifier(storageTableNameFor({ prefix, table: "checkpoints" })),
  inbox: quoteIdentifier(storageTableNameFor({ prefix, table: "inbox" })),
  deadLetters: quoteIdentifier(storageTableNameFor({ prefix, table: "deadLetters" })),
  scheduledCommands: quoteIdentifier(storageTableNameFor({ prefix, table: "scheduledCommands" })),
  idempotencyKeys: quoteIdentifier(storageTableNameFor({ prefix, table: "idempotencyKeys" })),
  personalKeys: quoteIdentifier(storageTableNameFor({ prefix, table: "personalKeys" })),
  persons: quoteIdentifier(storageTableNameFor({ prefix, table: "persons" })),
  snapshots: quoteIdentifier(storageTableNameFor({ prefix, table: "snapshots" })),
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
    "person" TEXT,
    UNIQUE ("aggregate_type", "aggregate_id", "version")
  )`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.events, "person")} ON ${tables.events} ("person", "position")`,
  `CREATE TABLE IF NOT EXISTS ${tables.eventTypes} (
    "aggregate_type" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    PRIMARY KEY ("aggregate_type", "type", "schema_version")
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
    "person" TEXT,
    "error_type" TEXT NOT NULL,
    "error_name" TEXT NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT NOT NULL,
    "error_stack" TEXT,
    "attempts" INTEGER NOT NULL,
    "first_failed_at" TEXT NOT NULL,
    "last_failed_at" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" TEXT,
    "persons" TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "listing")} ON ${tables.deadLetters} ("status", "first_failed_at", "id")`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "person")} ON ${tables.deadLetters} ("person")`,
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
    "claim_id" TEXT,
    "persons" TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.scheduledCommands, "execute_at")} ON ${tables.scheduledCommands} ("execute_at")`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.scheduledCommands, "unclaimed")} ON ${tables.scheduledCommands} ("execute_at") WHERE "claimed_at" IS NULL`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.scheduledCommands, "claimed_at")} ON ${tables.scheduledCommands} ("claimed_at") WHERE "claimed_at" IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ${tables.idempotencyKeys} (
    "key" TEXT PRIMARY KEY,
    "fingerprint" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "expires_at" TEXT NOT NULL,
    "persons" TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.idempotencyKeys, "expires_at")} ON ${tables.idempotencyKeys} ("expires_at")`,
  `CREATE TABLE IF NOT EXISTS ${tables.personalKeys} (
    "person" TEXT PRIMARY KEY,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "kid" TEXT
  )`,
  // What the rotation of the wrapping key reads: the keys still under an old one.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.personalKeys, "kid")} ON ${tables.personalKeys} ("kid", "person")`,
  `CREATE TABLE IF NOT EXISTS ${tables.persons} (
    "person" TEXT PRIMARY KEY,
    "restricted_since" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "last_active_at" TEXT,
    "forgotten_at" TEXT
  )`,
  // What a retention sweep reads, least recently active first.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.persons, "idle")} ON ${tables.persons} ("last_active_at", "person") WHERE "last_active_at" IS NOT NULL AND "forgotten_at" IS NULL AND "restricted_since" IS NULL`,
  `CREATE TABLE IF NOT EXISTS ${tables.snapshots} (
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "persons" TEXT NOT NULL,
    PRIMARY KEY ("aggregate_type", "aggregate_id")
  )`,
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
