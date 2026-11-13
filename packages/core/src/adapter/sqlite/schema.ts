import { quoteIdentifier, storageTableNameFor } from "../sql/index.ts";

// Every name is already quoted.
export interface StorageTables {
  readonly events: string;
  readonly checkpoints: string;
  readonly inbox: string;
  readonly deadLetters: string;
  readonly scheduledCommands: string;
  readonly idempotencyKeys: string;
  readonly personalKeys: string;
  readonly indexKeys: string;
  readonly persons: string;
  readonly snapshots: string;
  readonly personRows: string;
  readonly subscriberFailures: string;
  readonly restrictions: string;
  readonly restrictedPersons: string;
  readonly restrictedPositions: string;
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
  idempotencyKeys: quoteIdentifier(storageTableNameFor({ prefix, table: "idempotencyKeys" })),
  personalKeys: quoteIdentifier(storageTableNameFor({ prefix, table: "personalKeys" })),
  indexKeys: quoteIdentifier(storageTableNameFor({ prefix, table: "indexKeys" })),
  persons: quoteIdentifier(storageTableNameFor({ prefix, table: "persons" })),
  snapshots: quoteIdentifier(storageTableNameFor({ prefix, table: "snapshots" })),
  personRows: quoteIdentifier(storageTableNameFor({ prefix, table: "personRows" })),
  subscriberFailures: quoteIdentifier(storageTableNameFor({ prefix, table: "subscriberFailures" })),
  restrictions: quoteIdentifier(storageTableNameFor({ prefix, table: "restrictions" })),
  restrictedPersons: quoteIdentifier(storageTableNameFor({ prefix, table: "restrictedPersons" })),
  restrictedPositions: quoteIdentifier(
    storageTableNameFor({ prefix, table: "restrictedPositions" }),
  ),
});

/**
 * A store whose rows name persons in a `persons` column, and the columns of its primary key.
 */
export interface PersonIndexedStore {
  readonly store: string;
  readonly key: readonly string[];
}

export const PERSON_INDEXED: {
  readonly snapshots: PersonIndexedStore;
  readonly idempotencyKeys: PersonIndexedStore;
  readonly scheduledCommands: PersonIndexedStore;
  readonly deadLetters: PersonIndexedStore;
} = {
  snapshots: { store: "snapshots", key: ["aggregate_type", "aggregate_id"] },
  idempotencyKeys: { store: "idempotency_keys", key: ["key"] },
  scheduledCommands: { store: "scheduled_commands", key: ["dedupe_key"] },
  deadLetters: { store: "dead_letters", key: ["id"] },
};

// A row's key as `personRows` keeps it: the JSON array of its key columns.
const rowOf = (row: string, { key }: PersonIndexedStore): string =>
  `json_array(${key.map((column) => `${row}."${column}"`).join(", ")})`;

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

// A row's references follow its `persons` in the statement that writes or removes the row, whatever
// runs it: writing a row's `persons` again is how its references are rewritten.
const personRowTriggers = (
  tables: StorageTables,
  table: string,
  indexed: PersonIndexedStore,
): readonly string[] => {
  const trigger = (event: string): string =>
    quoteIdentifier(`${tables.personRows.slice(1, -1)}_${indexed.store}_${event}`);
  const insert = `INSERT OR IGNORE INTO ${tables.personRows} ("person", "store", "row") SELECT json_extract("value", '$.person'), '${indexed.store}', ${rowOf("NEW", indexed)} FROM json_each(NEW."persons");`;
  const remove = `DELETE FROM ${tables.personRows} WHERE "store" = '${indexed.store}' AND "row" = ${rowOf("OLD", indexed)};`;
  const columns = ["persons", ...indexed.key].map((column) => `"${column}"`).join(", ");
  return [
    `CREATE TRIGGER IF NOT EXISTS ${trigger("insert")} AFTER INSERT ON ${table} BEGIN ${insert} END`,
    `CREATE TRIGGER IF NOT EXISTS ${trigger("update")} AFTER UPDATE OF ${columns} ON ${table} BEGIN ${remove} ${insert} END`,
    `CREATE TRIGGER IF NOT EXISTS ${trigger("delete")} AFTER DELETE ON ${table} BEGIN ${remove} END`,
  ];
};

export interface StorageSchemaStatementsFunction {
  (tables: StorageTables): readonly string[];
}

// The storage tables as the first migration leaves them; later migrations change them from there.
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
    "resolved_at" TEXT,
    "payload" TEXT,
    "persons" TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "listing")} ON ${tables.deadLetters} ("status", "first_failed_at", "id")`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "person")} ON ${tables.deadLetters} ("person")`,
  // What the retention of resolved letters reads and purges, earliest first.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.deadLetters, "resolved")} ON ${tables.deadLetters} ("resolved_at", "id") WHERE "resolved_at" IS NOT NULL`,
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
    "kid" TEXT,
    "held_until" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0
  )`,
  // What the rotation of the wrapping key reads: the keys still under an old one.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.personalKeys, "kid")} ON ${tables.personalKeys} ("kid", "person")`,
  // When the rotation is next due while every key it has left is held.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.personalKeys, "held")} ON ${tables.personalKeys} ("held_until") WHERE "held_until" IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ${tables.persons} (
    "person" TEXT PRIMARY KEY,
    "restricted_since" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "last_active_at" TEXT,
    "forgotten_at" TEXT,
    "held_until" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0
  )`,
  // What a retention sweep reads, least recently active first.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.persons, "idle")} ON ${tables.persons} ("last_active_at", "person") WHERE "last_active_at" IS NOT NULL AND "forgotten_at" IS NULL AND "restricted_since" IS NULL`,
  // When the sweep is next due while the persons it has left are held.
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.persons, "held")} ON ${tables.persons} ("held_until") WHERE "last_active_at" IS NOT NULL AND "forgotten_at" IS NULL AND "restricted_since" IS NULL AND "held_until" IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ${tables.snapshots} (
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "persons" TEXT NOT NULL,
    PRIMARY KEY ("aggregate_type", "aggregate_id")
  )`,
  // Which rows of the stores whose triggers follow name which person, so `forget` and the export
  // find them by index instead of reading every `persons`.
  `CREATE TABLE IF NOT EXISTS ${tables.personRows} (
    "person" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "row" TEXT NOT NULL,
    PRIMARY KEY ("person", "store", "row")
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ${indexName(tables.personRows, "row")} ON ${tables.personRows} ("store", "row")`,
  ...personRowTriggers(tables, tables.snapshots, PERSON_INDEXED.snapshots),
  ...personRowTriggers(tables, tables.idempotencyKeys, PERSON_INDEXED.idempotencyKeys),
  ...personRowTriggers(tables, tables.scheduledCommands, PERSON_INDEXED.scheduledCommands),
  ...personRowTriggers(tables, tables.deadLetters, PERSON_INDEXED.deadLetters),
];

export interface PersonRowsBackfillStatementsFunction {
  (tables: StorageTables): readonly string[];
}

// The references of the rows written before their triggers existed.
export const personRowsBackfillStatements: PersonRowsBackfillStatementsFunction = (tables) =>
  (
    [
      [tables.snapshots, PERSON_INDEXED.snapshots],
      [tables.idempotencyKeys, PERSON_INDEXED.idempotencyKeys],
      [tables.scheduledCommands, PERSON_INDEXED.scheduledCommands],
      [tables.deadLetters, PERSON_INDEXED.deadLetters],
    ] as const
  ).map(
    ([table, indexed]) =>
      `INSERT OR IGNORE INTO ${tables.personRows} ("person", "store", "row") SELECT json_extract("named"."value", '$.person'), '${indexed.store}', ${rowOf('"stored"', indexed)} FROM ${table} AS "stored", json_each("stored"."persons") AS "named"`,
  );

export interface SubscriberFailuresTableStatementFunction {
  (table: string): string;
}

// Migration 2 of the storage tables. One row per subscriber, without an index: there are few.
export const subscriberFailuresTableStatement: SubscriberFailuresTableStatementFunction = (table) =>
  `CREATE TABLE IF NOT EXISTS ${table} (
    "subscriber" TEXT PRIMARY KEY,
    "position" INTEGER NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "person" TEXT,
    "error_name" TEXT NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT NOT NULL,
    "error_stack" TEXT,
    "attempts" INTEGER NOT NULL,
    "first_failed_at" TEXT NOT NULL,
    "last_failed_at" TEXT NOT NULL,
    "resolved_at" TEXT
  )`;

export interface RestrictionStatementsFunction {
  (tables: Pick<StorageTables, "events" | "persons" | "restrictions">): readonly string[];
}

// Migration 4 of the storage tables. A restriction recorded before it had a ground was of the
// person as a whole, and is taken in as `accuracy-contested`, the first ground of article 18(1);
// its events say so, and what restrictions the person had after each.
export const restrictionStatements: RestrictionStatementsFunction = (tables) => [
  `CREATE TABLE IF NOT EXISTS ${tables.restrictions} (
    "person" TEXT NOT NULL,
    "ground" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "since" TEXT NOT NULL,
    PRIMARY KEY ("person", "ground", "category")
  ) WITHOUT ROWID`,
  `INSERT OR IGNORE INTO ${tables.restrictions} ("person", "ground", "category", "since") SELECT "person", 'accuracy-contested', '', "restricted_since" FROM ${tables.persons} WHERE "restricted_since" IS NOT NULL`,
  `UPDATE ${tables.events} SET "payload" = json_set("payload", '$.ground', 'accuracy-contested', '$.categories', json('null'), '$.restrictions', json_array(json_object('ground', 'accuracy-contested', 'categories', json('null'), 'since', "timestamp"))) WHERE "aggregate_type" = 'bounda' AND "type" = 'ProcessingRestricted' AND json_type("payload", '$.ground') IS NULL`,
  `UPDATE ${tables.events} SET "payload" = json_set("payload", '$.grounds', json('["accuracy-contested"]'), '$.categories', json('null'), '$.restrictions', json('[]')) WHERE "aggregate_type" = 'bounda' AND "type" = 'ProcessingRestrictionLifted' AND json_type("payload", '$.grounds') IS NULL`,
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
    "person" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    PRIMARY KEY ("person", "source", "category")
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS ${tables.restrictedPositions} (
    "person" TEXT NOT NULL PRIMARY KEY,
    "position" INTEGER NOT NULL
  ) WITHOUT ROWID`,
];
