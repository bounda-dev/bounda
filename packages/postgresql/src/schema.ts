import { ConfigurationError } from "@bounda-dev/core";
import {
  quoteIdentifier,
  type SqlTransaction,
  storageTableNameFor,
} from "@bounda-dev/core/adapter/sql";
import type { PostgresqlDatabase } from "./database.ts";

export interface StorageTables {
  readonly events: string;
  readonly checkpoints: string;
  readonly inbox: string;
  readonly deadLetters: string;
  readonly scheduledCommands: string;
  readonly idempotencyKeys: string;
  readonly personalKeys: string;
  readonly indexKeys: string;
  readonly supersededKeys: string;
  readonly tenancy: string;
  readonly tenantFence: string;
  readonly persons: string;
  readonly restrictions: string;
  readonly restrictedPersons: string;
  readonly restrictedPositions: string;
  readonly snapshots: string;
  readonly subscriberFailures: string;
  readonly disclosures: string;
  readonly recipients: string;
  readonly forgottenRecipients: string;
  // In a database of its own, apart from the other storage tables.
  readonly forgetLedger: string;
  // The first key of the advisory lock that puts a tenant's ledger writes behind its fence.
  readonly forgetLedgerLockKey: string;
  readonly tenantKeys: string;
  readonly appendLockKey: string;
  // The first key of the advisory locks read models take on the checkpoints table.
  readonly checkpointsLockKey: string;
  // The `NOTIFY` channel appends publish on.
  readonly channel: string;
}

export interface FenceLockOfFunction {
  (checkpointsLockKey: string): readonly [string, string];
}

// The advisory lock every write holds shared, and a change of the fence exclusive: beside the read
// models' locks on the checkpoints table, under a name no subscriber takes.
export const fenceLockOf: FenceLockOfFunction = (checkpointsLockKey) => [
  checkpointsLockKey,
  "bounda:tenant-fence",
];

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

export const storageTablesFor: StorageTablesForFunction = ({ prefix, schema }) => {
  const events = storageTableNameFor({ prefix, table: "events" });
  const checkpoints = storageTableNameFor({ prefix, table: "checkpoints" });
  const forgetLedger = storageTableNameFor({ prefix, table: "forgetLedger" });
  // Advisory locks and channels belong to the whole database, so each is qualified by the schema:
  // stores in two schemas of one database never wait on each other.
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
    idempotencyKeys: quoteIdentifier(storageTableNameFor({ prefix, table: "idempotencyKeys" })),
    personalKeys: quoteIdentifier(storageTableNameFor({ prefix, table: "personalKeys" })),
    indexKeys: quoteIdentifier(storageTableNameFor({ prefix, table: "indexKeys" })),
    supersededKeys: quoteIdentifier(storageTableNameFor({ prefix, table: "supersededKeys" })),
    tenancy: quoteIdentifier(storageTableNameFor({ prefix, table: "tenancy" })),
    tenantFence: quoteIdentifier(storageTableNameFor({ prefix, table: "tenantFence" })),
    tenantKeys: quoteIdentifier(storageTableNameFor({ prefix, table: "tenantKeys" })),
    persons: quoteIdentifier(storageTableNameFor({ prefix, table: "persons" })),
    restrictions: quoteIdentifier(storageTableNameFor({ prefix, table: "restrictions" })),
    restrictedPersons: quoteIdentifier(storageTableNameFor({ prefix, table: "restrictedPersons" })),
    restrictedPositions: quoteIdentifier(
      storageTableNameFor({ prefix, table: "restrictedPositions" }),
    ),
    snapshots: quoteIdentifier(storageTableNameFor({ prefix, table: "snapshots" })),
    subscriberFailures: quoteIdentifier(
      storageTableNameFor({ prefix, table: "subscriberFailures" }),
    ),
    disclosures: quoteIdentifier(storageTableNameFor({ prefix, table: "disclosures" })),
    recipients: quoteIdentifier(storageTableNameFor({ prefix, table: "recipients" })),
    forgottenRecipients: quoteIdentifier(
      storageTableNameFor({ prefix, table: "forgottenRecipients" }),
    ),
    forgetLedger: quoteIdentifier(forgetLedger),
    forgetLedgerLockKey: `bounda:${schema}.${forgetLedger}`,
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

export interface SubscriberFailuresTableStatementFunction {
  (table: string): string;
}

// Migration 2 of the storage tables. One row per subscriber, without an index: there are few.
export const subscriberFailuresTableStatement: SubscriberFailuresTableStatementFunction = (table) =>
  `CREATE TABLE IF NOT EXISTS ${table} (
    "subscriber" text PRIMARY KEY,
    "position" bigint NOT NULL,
    "event_id" text NOT NULL,
    "event_type" text NOT NULL,
    "person" text,
    "error_name" text NOT NULL,
    "error_code" text,
    "error_message" text NOT NULL,
    "error_stack" text,
    "attempts" integer NOT NULL,
    "first_failed_at" text NOT NULL,
    "last_failed_at" text NOT NULL,
    "resolved_at" text,
    "read_persons" text NOT NULL DEFAULT '[]'
  )`;

export interface StorageSchemaStatementsFunction {
  (tables: StorageTables): readonly string[];
}

// Every statement must be able to run again on a database that already has the tables.
const leadingTablesStatements = (tables: StorageTables): readonly string[] => [
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
    "person" text,
    UNIQUE ("aggregate_type", "aggregate_id", "version")
  )`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.events, "person")} ON ${tables.events} ("person", "position")`,
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
    "person" text,
    "error_type" text NOT NULL,
    "error_name" text NOT NULL,
    "error_code" text,
    "error_message" text NOT NULL,
    "error_stack" text,
    "attempts" integer NOT NULL,
    "first_failed_at" text NOT NULL,
    "last_failed_at" text NOT NULL,
    "status" text NOT NULL,
    "resolved_at" text,
    "payload" jsonb,
    "persons" jsonb NOT NULL DEFAULT '[]',
    "state_person" text,
    "read_persons" jsonb NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "listing")} ON ${tables.deadLetters} ("status", "first_failed_at", "id")`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "person")} ON ${tables.deadLetters} ("person")`,
  statePersonIndexStatement(tables),
  // What the retention of resolved letters reads and purges, earliest first.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "resolved")} ON ${tables.deadLetters} ("resolved_at", "id") WHERE "resolved_at" IS NOT NULL`,
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
    "claim_id" text,
    "persons" jsonb NOT NULL DEFAULT '[]',
    "scheduled_at" text
  )`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.scheduledCommands, "execute_at")} ON ${tables.scheduledCommands} ("execute_at")`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.scheduledCommands, "unclaimed")} ON ${tables.scheduledCommands} ("execute_at") WHERE "claimed_at" IS NULL`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.scheduledCommands, "claimed_at")} ON ${tables.scheduledCommands} ("claimed_at") WHERE "claimed_at" IS NOT NULL`,
];

const personalKeysIndexStatements = (tables: StorageTables): readonly string[] => [
  // What the rotation of the wrapping key reads: the keys still under an old one.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.personalKeys, "kid")} ON ${tables.personalKeys} ("kid", "person")`,
  // When the rotation is next due while every key it has left is held.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.personalKeys, "held")} ON ${tables.personalKeys} ("held_until") WHERE "held_until" IS NOT NULL`,
];

const trailingTablesStatements = (tables: StorageTables): readonly string[] => [
  `CREATE TABLE IF NOT EXISTS ${tables.persons} (
    "person" text PRIMARY KEY,
    "restricted_since" text,
    "position" bigint NOT NULL DEFAULT 0,
    "last_active_at" text,
    "forgotten_at" text,
    "held_until" text,
    "attempts" integer NOT NULL DEFAULT 0
  )`,
  // What a retention sweep reads, least recently active first.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.persons, "idle")} ON ${tables.persons} ("last_active_at", "person") WHERE "last_active_at" IS NOT NULL AND "forgotten_at" IS NULL AND "restricted_since" IS NULL`,
  // When the sweep is next due while the persons it has left are held.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.persons, "held")} ON ${tables.persons} ("held_until") WHERE "last_active_at" IS NOT NULL AND "forgotten_at" IS NULL AND "restricted_since" IS NULL AND "held_until" IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ${tables.snapshots} (
    "aggregate_type" text NOT NULL,
    "aggregate_id" text NOT NULL,
    "version" integer NOT NULL,
    "fingerprint" text NOT NULL,
    "state" text NOT NULL,
    "persons" jsonb NOT NULL,
    PRIMARY KEY ("aggregate_type", "aggregate_id")
  )`,
  // So forgetting a person finds the rows that name them without reading every row.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.snapshots, "persons")} ON ${tables.snapshots} USING gin ("persons" jsonb_path_ops)`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.idempotencyKeys, "persons")} ON ${tables.idempotencyKeys} USING gin ("persons" jsonb_path_ops)`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.scheduledCommands, "persons")} ON ${tables.scheduledCommands} USING gin ("persons" jsonb_path_ops)`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "persons")} ON ${tables.deadLetters} USING gin ("persons" jsonb_path_ops)`,
  readPersonsIndexStatement(tables),
  ...scanIndexStatements(tables),
];

const idempotencyKeysIndexStatement = (tables: StorageTables): string =>
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.idempotencyKeys, "expires_at")} ON ${tables.idempotencyKeys} ("expires_at")`;

// The storage tables as the first migration leaves them; later migrations change them from there.
export const storageSchemaStatements: StorageSchemaStatementsFunction = (tables) => [
  ...leadingTablesStatements(tables),
  `CREATE TABLE IF NOT EXISTS ${tables.idempotencyKeys} (
    "key" text PRIMARY KEY,
    "fingerprint" text NOT NULL,
    "outcome" jsonb NOT NULL,
    "expires_at" text NOT NULL,
    "persons" jsonb NOT NULL
  )`,
  idempotencyKeysIndexStatement(tables),
  `CREATE TABLE IF NOT EXISTS ${tables.personalKeys} (
    "person" text PRIMARY KEY,
    "key" text NOT NULL,
    "fingerprint" text NOT NULL,
    "kid" text,
    "held_until" text,
    "attempts" integer NOT NULL DEFAULT 0
  )`,
  ...personalKeysIndexStatements(tables),
  ...trailingTablesStatements(tables),
];

export interface PersonalKeysCategoryIndexStatementsFunction {
  (tables: Pick<StorageTables, "personalKeys">): readonly string[];
}

// What the third migration of the storage tables indexes the keys by, once each has a category.
export const personalKeysCategoryIndexStatements: PersonalKeysCategoryIndexStatementsFunction = (
  tables,
) => [
  // One key in force per person and category, which `add` resolves its race on.
  `CREATE UNIQUE INDEX ${indexName(tables.personalKeys, "in_force")} ON ${tables.personalKeys} ("person", "category") WHERE "retained_since" IS NULL`,
  // What a category's retention reads, least recently active first.
  `CREATE INDEX ${indexName(tables.personalKeys, "due")} ON ${tables.personalKeys} ("category", "last_active_at") WHERE "last_active_at" IS NOT NULL`,
  // The keys a forgetting kept, which no legal obligation may keep any more.
  `CREATE INDEX ${indexName(tables.personalKeys, "retained")} ON ${tables.personalKeys} ("retained_since") WHERE "retained_since" IS NOT NULL`,
];

export interface LatestStorageTablesStatementsFunction {
  (tables: StorageTables): readonly string[];
}

// The tables of this file as the last migration of the storage tables leaves them. The keys keep
// the order of columns the third migration, which added the ones after `attempts`, leaves.
export const latestStorageTablesStatements: LatestStorageTablesStatementsFunction = (tables) => [
  ...leadingTablesStatements(tables),
  `CREATE TABLE IF NOT EXISTS ${tables.idempotencyKeys} (
    "key" text PRIMARY KEY,
    "outcome" jsonb NOT NULL,
    "expires_at" text NOT NULL,
    "persons" jsonb NOT NULL
  )`,
  idempotencyKeysIndexStatement(tables),
  `CREATE TABLE IF NOT EXISTS ${tables.personalKeys} (
    "person" text NOT NULL,
    "key" text NOT NULL,
    "fingerprint" text NOT NULL,
    "kid" text,
    "held_until" text,
    "attempts" integer NOT NULL DEFAULT 0,
    "category" text NOT NULL,
    "last_active_at" text,
    "retained_since" text,
    "forget_held_until" text,
    "forget_attempts" integer NOT NULL DEFAULT 0,
    PRIMARY KEY ("person", "fingerprint")
  )`,
  ...personalKeysIndexStatements(tables),
  ...personalKeysCategoryIndexStatements(tables),
  ...trailingTablesStatements(tables),
  subscriberFailuresTableStatement(tables.subscriberFailures),
  restrictionsTableStatement(tables.restrictions),
];

export interface InSchemaArgs<T> {
  readonly db: PostgresqlDatabase;
  readonly schema: string;
  readonly work: (tx: SqlTransaction) => Promise<T>;
}

export interface InSchemaFunction {
  <T>(args: InSchemaArgs<T>): Promise<T>;
}

/**
 * Runs `work` in one transaction that holds the schema's lock and has created the schema. The
 * tables and read models a boot creates or evolves go through it, so instances starting together
 * change the schema one after the other, each reading what the one before wrote: two of them never
 * add the same column. Only a change takes it: `work` reads again what it found missing.
 */
export const inSchema: InSchemaFunction = ({ db, schema, work }) =>
  db.write(async (tx) => {
    await tx.run("SELECT pg_advisory_xact_lock(hashtext($1))", [`bounda:${schema}:schema`]);
    await tx.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`, []);
    return work(tx);
  });

const restrictionsTableStatement = (table: string): string =>
  `CREATE TABLE IF NOT EXISTS ${table} (
    "person" text NOT NULL,
    "ground" text NOT NULL,
    "category" text NOT NULL,
    "since" text NOT NULL,
    PRIMARY KEY ("person", "ground", "category")
  )`;

export interface RestrictionStatementsFunction {
  (tables: Pick<StorageTables, "events" | "persons" | "restrictions">): readonly string[];
}

// Migration 4 of the storage tables. A restriction recorded before it had a ground was of the
// person as a whole, and is taken in as `accuracy-contested`, the first ground of article 18(1);
// its events say so, and what restrictions the person had after each.
export const restrictionStatements: RestrictionStatementsFunction = (tables) => [
  restrictionsTableStatement(tables.restrictions),
  `INSERT INTO ${tables.restrictions} ("person", "ground", "category", "since") SELECT "person", 'accuracy-contested', '', "restricted_since" FROM ${tables.persons} WHERE "restricted_since" IS NOT NULL ON CONFLICT DO NOTHING`,
  `UPDATE ${tables.events} SET "payload" = "payload" || jsonb_build_object('ground', 'accuracy-contested', 'categories', 'null'::jsonb, 'restrictions', jsonb_build_array(jsonb_build_object('ground', 'accuracy-contested', 'categories', 'null'::jsonb, 'since', "timestamp"))) WHERE "aggregate_type" = 'bounda' AND "type" = 'ProcessingRestricted' AND "payload"->'ground' IS NULL`,
  `UPDATE ${tables.events} SET "payload" = "payload" || '{"grounds":["accuracy-contested"],"categories":null,"restrictions":[]}'::jsonb WHERE "aggregate_type" = 'bounda' AND "type" = 'ProcessingRestrictionLifted' AND "payload"->'grounds' IS NULL`,
];

export interface RestrictedPersonsTableStatementsFunction {
  (tables: Pick<StorageTables, "restrictedPersons" | "restrictedPositions">): readonly string[];
}

// Migration 2 of the checkpoint tables: the read side's copy of who is restricted, in every
// database that holds read models, which a query of one of them filters by, and the position of
// the last event of each person written into it.
export const restrictedPersonsTableStatements: RestrictedPersonsTableStatementsFunction = (
  tables,
) => [
  `CREATE TABLE IF NOT EXISTS ${tables.restrictedPersons} (
    "person" text NOT NULL,
    "source" text NOT NULL,
    "category" text NOT NULL,
    PRIMARY KEY ("person", "source", "category")
  )`,
  `CREATE TABLE IF NOT EXISTS ${tables.restrictedPositions} (
    "person" text NOT NULL PRIMARY KEY,
    "position" bigint NOT NULL
  )`,
];

export interface StatePersonIndexStatementFunction {
  (tables: Pick<StorageTables, "deadLetters">): string;
}

// What `listByPerson` finds a process letter by when the person is its instance's state's.
export const statePersonIndexStatement: StatePersonIndexStatementFunction = (tables) =>
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "state_person")} ON ${tables.deadLetters} ("state_person") WHERE "state_person" IS NOT NULL`;

export interface ReadPersonsIndexStatementFunction {
  (tables: Pick<StorageTables, "deadLetters">): string;
}

// Migration 11 of the storage tables: what `listByPerson` finds a letter by when the person is one
// its work read data of.
export const readPersonsIndexStatement: ReadPersonsIndexStatementFunction = (tables) =>
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "read_persons")} ON ${tables.deadLetters} USING gin ("read_persons" jsonb_path_ops)`;

export interface ScanIndexStatementsFunction {
  (
    tables: Pick<
      StorageTables,
      "deadLetters" | "scheduledCommands" | "persons" | "personalKeys" | "idempotencyKeys"
    >,
  ): readonly string[];
}

// Migration 12 of the storage tables: what a scan of every record, and the listing of remembered
// answers, page by, compared by bytes as SQLite compares them, which the primary keys, in the
// database's collation, cannot serve.
export const scanIndexStatements: ScanIndexStatementsFunction = (tables) => [
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "id_bytes")} ON ${tables.deadLetters} ("id" COLLATE "C")`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.scheduledCommands, "key_bytes")} ON ${tables.scheduledCommands} ("dedupe_key" COLLATE "C")`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.persons, "person_bytes")} ON ${tables.persons} ("person" COLLATE "C")`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.personalKeys, "person_bytes")} ON ${tables.personalKeys} ("person" COLLATE "C")`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.idempotencyKeys, "key_bytes")} ON ${tables.idempotencyKeys} ("key" COLLATE "C")`,
];
