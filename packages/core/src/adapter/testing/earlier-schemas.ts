import { storageTableNameFor } from "../sql/identifiers.ts";

// The storage tables exactly as released versions created them, before the tables were versioned:
// what the first migration has to take in. Frozen: never edit one to follow the current tables.

export interface EarlierTables {
  readonly events: string;
  readonly checkpoints: string;
  readonly inbox: string;
  readonly deadLetters: string;
  readonly scheduledCommands: string;
  readonly idempotencyKeys: string;
  readonly personalKeys: string;
  readonly snapshots: string;
}

export interface EarlierTablesForFunction {
  (prefix: string): EarlierTables;
}

export const earlierTablesFor: EarlierTablesForFunction = (prefix) => {
  const name = (table: keyof EarlierTables): string =>
    `"${storageTableNameFor({ prefix, table })}"`;
  return {
    events: name("events"),
    checkpoints: name("checkpoints"),
    inbox: name("inbox"),
    deadLetters: name("deadLetters"),
    scheduledCommands: name("scheduledCommands"),
    idempotencyKeys: name("idempotencyKeys"),
    personalKeys: name("personalKeys"),
    snapshots: name("snapshots"),
  };
};

const index = (table: string, suffix: string): string => `"${table.slice(1, -1)}_${suffix}_idx"`;

export type EarlierVersion = "0.2.0" | "0.3.0";

export const EARLIER_SCHEMAS: Readonly<
  Record<
    "sqlite" | "postgresql",
    Readonly<Record<EarlierVersion, (t: EarlierTables) => readonly string[]>>
  >
> = {
  sqlite: {
    "0.2.0": (t) => [
      `CREATE TABLE IF NOT EXISTS ${t.events} (
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
      `CREATE TABLE IF NOT EXISTS ${t.checkpoints} (
    "subscriber" TEXT PRIMARY KEY,
    "position" INTEGER NOT NULL
  )`,
      `CREATE TABLE IF NOT EXISTS ${t.inbox} (
    "handler" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "claimed_at" TEXT NOT NULL,
    "claim_id" TEXT,
    "last_error" TEXT,
    PRIMARY KEY ("handler", "event_id")
  )`,
      `CREATE TABLE IF NOT EXISTS ${t.deadLetters} (
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
      `CREATE INDEX IF NOT EXISTS ${index(t.deadLetters, "status")} ON ${t.deadLetters} ("status")`,
      `CREATE TABLE IF NOT EXISTS ${t.scheduledCommands} (
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
      `CREATE INDEX IF NOT EXISTS ${index(t.scheduledCommands, "execute_at")} ON ${t.scheduledCommands} ("execute_at")`,
    ],
    "0.3.0": (t) => [
      `CREATE TABLE IF NOT EXISTS ${t.events} (
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
      `CREATE TABLE IF NOT EXISTS ${t.checkpoints} (
    "subscriber" TEXT PRIMARY KEY,
    "position" INTEGER NOT NULL
  )`,
      `CREATE TABLE IF NOT EXISTS ${t.inbox} (
    "handler" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "claimed_at" TEXT NOT NULL,
    "claim_id" TEXT,
    "last_error" TEXT,
    PRIMARY KEY ("handler", "event_id")
  )`,
      `CREATE TABLE IF NOT EXISTS ${t.deadLetters} (
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
    "payload" TEXT,
    "persons" TEXT NOT NULL DEFAULT '[]'
  )`,
      `CREATE INDEX IF NOT EXISTS ${index(t.deadLetters, "status")} ON ${t.deadLetters} ("status")`,
      `CREATE TABLE IF NOT EXISTS ${t.scheduledCommands} (
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
      `CREATE INDEX IF NOT EXISTS ${index(t.scheduledCommands, "execute_at")} ON ${t.scheduledCommands} ("execute_at")`,
      `CREATE TABLE IF NOT EXISTS ${t.idempotencyKeys} (
    "key" TEXT PRIMARY KEY,
    "fingerprint" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "expires_at" TEXT NOT NULL,
    "persons" TEXT NOT NULL
  )`,
      `CREATE INDEX IF NOT EXISTS ${index(t.idempotencyKeys, "expires_at")} ON ${t.idempotencyKeys} ("expires_at")`,
      `CREATE TABLE IF NOT EXISTS ${t.personalKeys} (
    "person" TEXT PRIMARY KEY,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL
  )`,
      `CREATE TABLE IF NOT EXISTS ${t.snapshots} (
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "persons" TEXT NOT NULL,
    PRIMARY KEY ("aggregate_type", "aggregate_id")
  )`,
    ],
  },
  postgresql: {
    "0.2.0": (t) => [
      `CREATE TABLE IF NOT EXISTS ${t.events} (
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
      `CREATE TABLE IF NOT EXISTS ${t.checkpoints} (
    "subscriber" text PRIMARY KEY,
    "position" bigint NOT NULL
  )`,
      `CREATE TABLE IF NOT EXISTS ${t.inbox} (
    "handler" text NOT NULL,
    "event_id" text NOT NULL,
    "status" text NOT NULL,
    "attempts" integer NOT NULL,
    "claimed_at" text NOT NULL,
    "claim_id" text,
    "last_error" text,
    PRIMARY KEY ("handler", "event_id")
  )`,
      `CREATE TABLE IF NOT EXISTS ${t.deadLetters} (
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
      `CREATE INDEX IF NOT EXISTS ${index(t.deadLetters, "status")} ON ${t.deadLetters} ("status")`,
      `CREATE TABLE IF NOT EXISTS ${t.scheduledCommands} (
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
      `CREATE INDEX IF NOT EXISTS ${index(t.scheduledCommands, "execute_at")} ON ${t.scheduledCommands} ("execute_at")`,
    ],
    "0.3.0": (t) => [
      `CREATE TABLE IF NOT EXISTS ${t.events} (
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
      `CREATE TABLE IF NOT EXISTS ${t.checkpoints} (
    "subscriber" text PRIMARY KEY,
    "position" bigint NOT NULL
  )`,
      `CREATE TABLE IF NOT EXISTS ${t.inbox} (
    "handler" text NOT NULL,
    "event_id" text NOT NULL,
    "status" text NOT NULL,
    "attempts" integer NOT NULL,
    "claimed_at" text NOT NULL,
    "claim_id" text,
    "last_error" text,
    PRIMARY KEY ("handler", "event_id")
  )`,
      `CREATE TABLE IF NOT EXISTS ${t.deadLetters} (
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
    "payload" jsonb,
    "persons" jsonb NOT NULL DEFAULT '[]'
  )`,
      `CREATE INDEX IF NOT EXISTS ${index(t.deadLetters, "status")} ON ${t.deadLetters} ("status")`,
      `CREATE TABLE IF NOT EXISTS ${t.scheduledCommands} (
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
    "claim_id" text,
    "persons" jsonb NOT NULL DEFAULT '[]'
  )`,
      `CREATE INDEX IF NOT EXISTS ${index(t.scheduledCommands, "execute_at")} ON ${t.scheduledCommands} ("execute_at")`,
      `CREATE TABLE IF NOT EXISTS ${t.idempotencyKeys} (
    "key" text PRIMARY KEY,
    "fingerprint" text NOT NULL,
    "outcome" jsonb NOT NULL,
    "expires_at" text NOT NULL,
    "persons" jsonb NOT NULL
  )`,
      `CREATE INDEX IF NOT EXISTS ${index(t.idempotencyKeys, "expires_at")} ON ${t.idempotencyKeys} ("expires_at")`,
      `CREATE TABLE IF NOT EXISTS ${t.personalKeys} (
    "person" text PRIMARY KEY,
    "key" text NOT NULL,
    "fingerprint" text NOT NULL
  )`,
      `CREATE TABLE IF NOT EXISTS ${t.snapshots} (
    "aggregate_type" text NOT NULL,
    "aggregate_id" text NOT NULL,
    "version" integer NOT NULL,
    "fingerprint" text NOT NULL,
    "state" text NOT NULL,
    "persons" jsonb NOT NULL,
    PRIMARY KEY ("aggregate_type", "aggregate_id")
  )`,
      `CREATE INDEX IF NOT EXISTS ${index(t.snapshots, "persons")} ON ${t.snapshots} USING gin ("persons" jsonb_path_ops)`,
      `CREATE INDEX IF NOT EXISTS ${index(t.idempotencyKeys, "persons")} ON ${t.idempotencyKeys} USING gin ("persons" jsonb_path_ops)`,
      `CREATE INDEX IF NOT EXISTS ${index(t.scheduledCommands, "persons")} ON ${t.scheduledCommands} USING gin ("persons" jsonb_path_ops)`,
      `CREATE INDEX IF NOT EXISTS ${index(t.deadLetters, "persons")} ON ${t.deadLetters} USING gin ("persons" jsonb_path_ops)`,
    ],
  },
};
