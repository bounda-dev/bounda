import { ConfigurationError } from "@bounda-dev/core";
import { quoteIdentifier, storageTableNameFor } from "@bounda-dev/core/adapter/sql";
import type { PostgresqlDatabase } from "./database.ts";

/**
 * The quoted names of the storage tables for a table prefix, plus what serialises appends and
 * announces them. Advisory locks and channels belong to the whole database, so each is qualified
 * by the schema: stores in two schemas of one database never wait on each other.
 */
export interface StorageTables {
  readonly events: string;
  readonly checkpoints: string;
  readonly inbox: string;
  readonly deadLetters: string;
  readonly scheduledCommands: string;
  readonly appendLockKey: string;
  /**
   * The first key of the advisory locks read models take on the checkpoints table.
   */
  readonly checkpointsLockKey: string;
  /**
   * The `NOTIFY` channel appends publish on: `<schema>.<events table>`.
   */
  readonly channel: string;
}

export interface StorageTablesForArgs {
  readonly prefix: string;
  readonly schema: string;
}

export interface StorageTablesForFunction {
  (args: StorageTablesForArgs): StorageTables;
}

/**
 * PostgreSQL's limit on an identifier, which a channel name is.
 */
const MAX_CHANNEL_BYTES = 63;

/**
 * The tables, lock keys and channel `postgresql()` uses for a table prefix in a schema. Throws
 * `ConfigurationError` when the schema and prefix make a channel name PostgreSQL cannot hold.
 */
export const storageTablesFor: StorageTablesForFunction = ({ prefix, schema }) => {
  const events = storageTableNameFor({ prefix, table: "events" });
  const checkpoints = storageTableNameFor({ prefix, table: "checkpoints" });
  const channel = `${schema}.${events}`;
  if (Buffer.byteLength(channel) > MAX_CHANNEL_BYTES) {
    throw new ConfigurationError(
      `schema "${schema}" and tablePrefix "${prefix}" make the notification channel "${channel}", longer than PostgreSQL's ${MAX_CHANNEL_BYTES} bytes; shorten one of them`,
    );
  }
  return {
    events: quoteIdentifier(events),
    checkpoints: quoteIdentifier(checkpoints),
    inbox: quoteIdentifier(storageTableNameFor({ prefix, table: "inbox" })),
    deadLetters: quoteIdentifier(storageTableNameFor({ prefix, table: "deadLetters" })),
    scheduledCommands: quoteIdentifier(storageTableNameFor({ prefix, table: "scheduledCommands" })),
    appendLockKey: `bounda:${schema}.${events}`,
    checkpointsLockKey: `bounda:${schema}.${checkpoints}`,
    channel,
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
