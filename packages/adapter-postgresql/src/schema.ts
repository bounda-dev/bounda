import { quoteIdentifier, tableNameFor } from "@bounda-dev/core/adapter/sql";
import type { PostgresqlDatabase } from "./database.ts";

/**
 * The quoted names of the storage tables for a table prefix, plus the advisory-lock key that
 * serialises appends to the event store.
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

/**
 * The tables, lock key and channel `postgresql()` uses for a table prefix.
 */
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

export interface CheckpointTableStatementFunction {
  (table: string): string;
}

export const checkpointTableStatement: CheckpointTableStatementFunction = (table) =>
  `CREATE TABLE IF NOT EXISTS ${table} (
    "subscriber" text PRIMARY KEY,
    "position" bigint NOT NULL
  )`;

export interface StorageSchemaStatementsFunction {
  (tables: StorageTables): readonly string[];
}

/**
 * DDL for the storage tables, which `postgresql()` runs on first use. Every statement can run
 * again on a database that already has them.
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
  checkpointTableStatement(tables.checkpoints),
  `CREATE TABLE IF NOT EXISTS ${tables.inbox} (
    "handler" text NOT NULL,
    "event_id" text NOT NULL,
    "status" text NOT NULL,
    "attempts" integer NOT NULL,
    "claimed_at" text NOT NULL,
    "claim_id" text,
    "last_error" text,
    PRIMARY KEY ("handler", "event_id")
  )`,
  `CREATE TABLE IF NOT EXISTS ${tables.deadLetters} (
    "id" text PRIMARY KEY,
    "kind" text NOT NULL,
    "handler" text NOT NULL,
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
    "last_error" text,
    "revision" integer NOT NULL DEFAULT 0,
    "claim_id" text
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

export const ensureStorageSchema: EnsureStorageSchemaFunction = async ({ db, schema, tables }) => {
  await db.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`, []);
  for (const statement of storageSchemaStatements(tables)) await db.run(statement, []);
};
