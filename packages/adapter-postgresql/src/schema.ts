import { quoteIdentifier, tableNameFor } from "@bounda-dev/core/adapter/sql";
import type { PostgresqlDatabase } from "./database.ts";

/**
 * The quoted names of the five storage tables for a table prefix, plus the advisory-lock key
 * that serialises appends to the event store.
 */
export interface StorageTables {
  readonly events: string;
  readonly checkpoints: string;
  readonly inbox: string;
  readonly deadLetters: string;
  readonly scheduledCommands: string;
  readonly appendLockKey: string;
  /**
   * The `NOTIFY` channel appends publish on: the events table name, which is unique per prefix.
   */
  readonly channel: string;
}

export interface StorageTablesForFunction {
  (prefix: string): StorageTables;
}

export const storageTablesFor: StorageTablesForFunction = (prefix) => {
  const events = tableNameFor({ prefix, readModel: "events" });
  return {
    events: quoteIdentifier(events),
    checkpoints: quoteIdentifier(tableNameFor({ prefix, readModel: "checkpoints" })),
    inbox: quoteIdentifier(tableNameFor({ prefix, readModel: "inbox" })),
    deadLetters: quoteIdentifier(tableNameFor({ prefix, readModel: "deadLetters" })),
    scheduledCommands: quoteIdentifier(tableNameFor({ prefix, readModel: "scheduledCommands" })),
    appendLockKey: `bounda:${events}`,
    channel: events,
  };
};

const indexName = (table: string, suffix: string): string =>
  quoteIdentifier(`${table.slice(1, -1)}_${suffix}_idx`);

export interface StorageSchemaStatementsFunction {
  (tables: StorageTables): readonly string[];
}

/**
 * DDL for the write side. `position` is a `BIGSERIAL`; appends take a transaction-scoped advisory
 * lock, so positions are handed out in commit order and `readAll` never sees a gap that a still
 * uncommitted transaction would later fill.
 */
export const storageSchemaStatements: StorageSchemaStatementsFunction = (tables) => [
  `CREATE TABLE IF NOT EXISTS ${tables.events} (
    "position" BIGSERIAL PRIMARY KEY,
    "id" text NOT NULL UNIQUE,
    "aggregate_type" text NOT NULL,
    "aggregate_id" text NOT NULL,
    "version" integer NOT NULL,
    "type" text NOT NULL,
    "payload" jsonb NOT NULL,
    "timestamp" text NOT NULL,
    "metadata" jsonb NOT NULL,
    UNIQUE ("aggregate_type", "aggregate_id", "version")
  )`,
  `CREATE TABLE IF NOT EXISTS ${tables.checkpoints} (
    "subscriber" text PRIMARY KEY,
    "position" bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${tables.inbox} (
    "subscriber" text NOT NULL,
    "event_id" text NOT NULL,
    "status" text NOT NULL,
    "attempts" integer NOT NULL,
    "claimed_at" text NOT NULL,
    "last_error" text,
    PRIMARY KEY ("subscriber", "event_id")
  )`,
  `CREATE TABLE IF NOT EXISTS ${tables.deadLetters} (
    "id" text PRIMARY KEY,
    "kind" text NOT NULL,
    "subscriber" text NOT NULL,
    "event_id" text NOT NULL,
    "event_type" text NOT NULL,
    "aggregate_type" text NOT NULL,
    "aggregate_id" text NOT NULL,
    "error_type" text NOT NULL,
    "error_message" text NOT NULL,
    "error_stack" text,
    "attempts" integer NOT NULL,
    "first_failed_at" text NOT NULL,
    "last_failed_at" text NOT NULL,
    "status" text NOT NULL,
    "payload" jsonb
  )`,
  `ALTER TABLE ${tables.deadLetters} ADD COLUMN IF NOT EXISTS "payload" jsonb`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "status")} ON ${tables.deadLetters} ("status")`,
  `CREATE TABLE IF NOT EXISTS ${tables.scheduledCommands} (
    "dedupe_key" text PRIMARY KEY,
    "command_type" text NOT NULL,
    "aggregate_id" text NOT NULL,
    "payload" jsonb NOT NULL,
    "execute_at" text NOT NULL,
    "context" jsonb NOT NULL,
    "attempts" integer NOT NULL,
    "claimed_at" text,
    "last_error" text
  )`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.scheduledCommands, "execute_at")} ON ${tables.scheduledCommands} ("execute_at")`,
];

export interface EnsureStorageSchemaArgs {
  readonly db: PostgresqlDatabase;
  readonly schema: string;
  readonly tables: StorageTables;
}

export interface EnsureStorageSchemaFunction {
  (args: EnsureStorageSchemaArgs): Promise<void>;
}

/**
 * Creates the schema and the storage tables that do not exist yet.
 */
export const ensureStorageSchema: EnsureStorageSchemaFunction = async ({ db, schema, tables }) => {
  await db.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`, []);
  for (const statement of storageSchemaStatements(tables)) await db.run(statement, []);
};
