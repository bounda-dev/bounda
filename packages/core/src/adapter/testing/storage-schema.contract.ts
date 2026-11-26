import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import {
  ConfigurationError,
  StorageSchemaTooNewError,
  TenantFrozenError,
} from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { createApp } from "../../kernel/app.ts";
import type { TenantExportPart } from "../../kernel/personal-data/tenant-export.ts";
import { DEFAULT_TENANT } from "../../kernel/personal-data/tenant-keys.ts";
import { memory } from "../../memory/index.ts";
import type { Registry } from "../../modules/registry.ts";
import type { Adapter, Storage } from "../adapter.ts";
import { forgetLedgerFenceTableFor, forgetLedgerMarksTableFor } from "../sql/forget-ledger.ts";
import { quoteIdentifier, storageTableNameFor } from "../sql/identifiers.ts";
import { schemaMigrationsTableFor, schemaMigrationsTableStatement } from "../sql/migrations.ts";
import { DOCUMENTED_TABLES, SQLITE_ONLY_TABLES } from "./documented-tables.ts";
import { earlierRowsFor, expectEarlierRowsTakenIn } from "./earlier-rows.ts";
import { EARLIER_SCHEMAS, type EarlierVersion, earlierTablesFor } from "./earlier-schemas.ts";
import { testCommand, testContext, testDeadLetter } from "./fixtures.ts";
import { contractFields } from "./table.contract.ts";

/**
 * A database for one case: `adapter` opens it under `prefix`, and `execute` runs a statement on
 * it outside the adapter.
 */
export interface StorageSchemaTarget {
  readonly adapter: Adapter;
  readonly prefix: string;
  readonly execute: (statement: string) => Promise<readonly Record<string, unknown>[]>;
}

export interface StorageSchemaContractArgs {
  // A new database, or a new prefix in one, on every call.
  readonly create: () => Promise<StorageSchemaTarget>;
  readonly dialect: "sqlite" | "postgresql";
  // Whether storages opening at once can be awaited together; not inside a Durable Object.
  readonly concurrent?: boolean;
}

export interface StorageSchemaContractFunction {
  (args: StorageSchemaContractArgs): void;
}

// What a new database holds: every migration of every scope the storage migrates, one row each.
const LATEST = [
  { scope: "checkpoints", version: 1 },
  { scope: "checkpoints", version: 2 },
  { scope: "checkpoints", version: 3 },
  { scope: "checkpoints", version: 4 },
  { scope: "checkpoints", version: 5 },
  { scope: "storage", version: 1 },
  { scope: "storage", version: 2 },
  { scope: "storage", version: 3 },
  { scope: "storage", version: 4 },
  { scope: "storage", version: 5 },
  { scope: "storage", version: 6 },
  { scope: "storage", version: 7 },
  { scope: "storage", version: 8 },
  { scope: "storage", version: 9 },
  { scope: "storage", version: 10 },
  { scope: "storage", version: 11 },
  { scope: "storage", version: 12 },
];

// PostgreSQL's storage takes one more: the indexes that compare text by bytes, as SQLite's does.
const STORAGE_LATEST: Readonly<Record<StorageSchemaContractArgs["dialect"], number>> = {
  sqlite: 12,
  postgresql: 13,
};

const latestOf = (dialect: StorageSchemaContractArgs["dialect"]) =>
  dialect === "sqlite" ? LATEST : [...LATEST, { scope: "storage", version: 13 }];

// A fence raised under the forget ledger's empty name or DEFAULT_TENANT, `day` its since in 2026-01.
interface LegacyFence {
  readonly state: "frozen" | "forgotten";
  readonly day: number;
}

const sinceOn = (day: number): string => `2026-01-0${day}T00:00:00.000Z`;

const versionsOf = async ({ execute, prefix }: StorageSchemaTarget) =>
  (
    await execute(
      `SELECT "scope", "version", "applied_at" FROM ${schemaMigrationsTableFor(prefix)} ORDER BY "scope", "version"`,
    )
  ).map(({ scope, version, applied_at }) => ({
    scope: String(scope),
    version: Number(version),
    appliedAt: String(applied_at),
  }));

const opened = async <T>(adapter: Adapter, work: (storage: Storage) => Promise<T>): Promise<T> => {
  const storage = await adapter.createStorage();
  try {
    return await work(storage);
  } finally {
    await storage.close();
  }
};

/**
 * The shape of a prefix's tables, the prefix taken out of every name so two prefixes compare:
 * columns with their type, nullability and primary key, then indexes and triggers as the engine
 * keeps their definition. Defaults count on PostgreSQL only: SQLite cannot drop the one a column
 * added to an existing table needs where a new table has none.
 */
const shapeOf = async (
  { execute, prefix }: StorageSchemaTarget,
  dialect: StorageSchemaContractArgs["dialect"],
): Promise<readonly string[]> => {
  const local = (text: unknown): string => String(text).replaceAll(prefix, "<prefix>");
  if (dialect === "sqlite") {
    const objects = await execute(
      `SELECT "type", "name", "sql" FROM sqlite_master WHERE substr("name", 1, ${prefix.length}) = '${prefix}' ORDER BY "type", "name"`,
    );
    const shape: string[] = [];
    for (const object of objects) {
      if (object.type === "table") {
        const columns = await execute(`PRAGMA table_info("${String(object.name)}")`);
        for (const column of columns) {
          shape.push(
            `column ${local(object.name)}.${String(column.name)} ${String(column.type)} notnull=${String(column.notnull)} pk=${String(column.pk)}`,
          );
        }
      } else {
        shape.push(`${String(object.type)} ${local(object.name)} ${local(object.sql)}`);
      }
    }
    return shape.sort();
  }
  const columns = await execute(
    `SELECT "table_name", "column_name", "data_type", "is_nullable", "column_default" FROM information_schema.columns WHERE "table_schema" = current_schema() AND starts_with("table_name", '${prefix}')`,
  );
  const indexes = await execute(
    `SELECT "indexname", "indexdef" FROM pg_indexes WHERE "schemaname" = current_schema() AND starts_with("tablename", '${prefix}')`,
  );
  return [
    ...columns.map(
      (column) =>
        `column ${local(column.table_name)}.${String(column.column_name)} ${String(column.data_type)} nullable=${String(column.is_nullable)} default=${local(column.column_default)}`,
    ),
    ...indexes.map((index) => `index ${local(index.indexname)} ${local(index.indexdef)}`),
  ].sort();
};

const createEarlier = async (
  target: StorageSchemaTarget,
  dialect: StorageSchemaContractArgs["dialect"],
  version: EarlierVersion,
): Promise<void> => {
  for (const statement of EARLIER_SCHEMAS[dialect][version](earlierTablesFor(target.prefix))) {
    await target.execute(statement);
  }
};

/**
 * What every adapter does with the versions of its own tables: a new database starts at the latest,
 * an unversioned one from a released version is taken in with what it holds, instances starting
 * together migrate it once, and a database a newer version migrated is refused untouched.
 */
export const storageSchemaContract: StorageSchemaContractFunction = ({
  create,
  dialect,
  concurrent = true,
}) => {
  describe("storage schema contract", () => {
    it("starts a new database at the latest version of every scope", async () => {
      const target = await create();
      await opened(target.adapter, async () => undefined);
      expect((await versionsOf(target)).map(({ scope, version }) => ({ scope, version }))).toEqual(
        latestOf(dialect),
      );
    });

    it("creates the tables the docs list, with a forget ledger and a tenant key store beside them, and no other", async () => {
      const target = await create();
      await opened(target.adapter, async () => undefined);
      const ledger = await target.adapter.createForgetLedger({ tenant: "t-1" });
      try {
        await ledger.read({ limit: 1 });
      } finally {
        await ledger.close?.();
      }
      const keys = await target.adapter.createTenantKeyStore();
      try {
        await keys.get("t-1");
      } finally {
        await keys.close?.();
      }
      const tables = await target.execute(
        dialect === "sqlite"
          ? `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND substr("name", 1, ${target.prefix.length}) = '${target.prefix}'`
          : `SELECT "table_name" AS "name" FROM information_schema.tables WHERE "table_schema" = current_schema() AND starts_with("table_name", '${target.prefix}')`,
      );
      expect(tables.map(({ name }) => String(name).slice(target.prefix.length)).sort()).toEqual(
        DOCUMENTED_TABLES.filter(
          (table) => dialect === "sqlite" || !SQLITE_ONLY_TABLES.includes(table),
        ).sort(),
      );
    });

    it("opens a database at the latest version without migrating it again", async () => {
      const target = await create();
      await opened(target.adapter, (storage) => storage.checkpointStore.set("projection:x", 7));
      const before = await versionsOf(target);
      const shape = await shapeOf(target, dialect);
      expect(
        await opened(target.adapter, (storage) => storage.checkpointStore.get("projection:x")),
      ).toBe(7);
      expect(await versionsOf(target)).toEqual(before);
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    it("reads the version of every scope without migrating, and migrates only the scopes asked", async () => {
      const target = await create();
      const versions = await target.adapter.schemaVersions();
      expect(versions).toEqual([
        { scope: "storage", version: 0, latest: STORAGE_LATEST[dialect] },
        { scope: "checkpoints", version: 0, latest: 5 },
        { scope: "forget-ledger", version: 0, latest: 13 },
        { scope: "tenant-keys", version: 0, latest: 1 },
      ]);
      expect(await shapeOf(target, dialect)).toEqual([]);
      expect(await target.adapter.migrate(["checkpoints"])).toEqual([
        { scope: "storage", version: 0, latest: STORAGE_LATEST[dialect] },
        { scope: "checkpoints", version: 5, latest: 5 },
        { scope: "forget-ledger", version: 0, latest: 13 },
        { scope: "tenant-keys", version: 0, latest: 1 },
      ]);
      expect(await target.adapter.migrate(["storage", "forget-ledger", "tenant-keys"])).toEqual([
        { scope: "storage", version: STORAGE_LATEST[dialect], latest: STORAGE_LATEST[dialect] },
        { scope: "checkpoints", version: 5, latest: 5 },
        { scope: "forget-ledger", version: 13, latest: 13 },
        { scope: "tenant-keys", version: 1, latest: 1 },
      ]);
      const shape = await shapeOf(target, dialect);
      await opened(target.adapter, async () => undefined);
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    it("refuses to migrate a scope a newer version migrated, writing nothing", async () => {
      const target = await create();
      const table = schemaMigrationsTableFor(target.prefix);
      await target.execute(schemaMigrationsTableStatement(table));
      await target.execute(
        `INSERT INTO ${table} ("scope", "version", "applied_at") VALUES ('checkpoints', 999, '2099-01-01T00:00:00.000Z')`,
      );
      const shape = await shapeOf(target, dialect);
      await expect(target.adapter.migrate(["storage", "checkpoints"])).rejects.toMatchObject({
        code: "STORAGE_SCHEMA_TOO_NEW",
        scope: "checkpoints",
      });
      expect(await shapeOf(target, dialect)).toEqual(shape);
      expect(await target.adapter.schemaVersions()).toContainEqual({
        scope: "checkpoints",
        version: 999,
        latest: 5,
      });
    });

    it.skipIf(!concurrent)("migrates once when instances start together", async () => {
      const target = await create();
      const storages = await Promise.all([1, 2, 3].map(() => target.adapter.createStorage()));
      try {
        for (const storage of storages) expect(await storage.eventStore.lastPosition()).toBe(0);
      } finally {
        await Promise.all(storages.map((storage) => storage.close()));
      }
      expect((await versionsOf(target)).map(({ scope, version }) => ({ scope, version }))).toEqual(
        latestOf(dialect),
      );
    });

    it("refuses a database a newer version migrated, and leaves it as it was", async () => {
      const target = await create();
      const table = schemaMigrationsTableFor(target.prefix);
      await target.execute(schemaMigrationsTableStatement(table));
      await target.execute(
        `INSERT INTO ${table} ("scope", "version", "applied_at") VALUES ('storage', 999, '2099-01-01T00:00:00.000Z')`,
      );
      const shape = await shapeOf(target, dialect);
      const refused = target.adapter.createStorage();
      await expect(refused).rejects.toBeInstanceOf(StorageSchemaTooNewError);
      await expect(refused).rejects.toMatchObject({
        code: "STORAGE_SCHEMA_TOO_NEW",
        scope: "storage",
        version: 999,
        supported: STORAGE_LATEST[dialect],
      });
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    for (const version of ["0.2.0", "0.3.0"] as const) {
      it(`takes in the tables of Bounda ${version} with what they hold, as a new database has them`, async () => {
        const fresh = await create();
        await opened(fresh.adapter, async () => undefined);
        const target = await create();
        await createEarlier(target, dialect, version);
        const tables = earlierTablesFor(target.prefix);
        for (const statement of earlierRowsFor(version, tables)) await target.execute(statement);
        await opened(target.adapter, (storage) =>
          expectEarlierRowsTakenIn({ storage, version, execute: target.execute, tables }),
        );
        expect(await shapeOf(target, dialect)).toEqual(await shapeOf(fresh, dialect));
        expect(
          (await versionsOf(target)).map(({ scope, version: at }) => ({ scope, version: at })),
        ).toEqual(latestOf(dialect));
      });
    }

    it("takes in the restrictions recorded before they had a ground, as of the person as a whole on the first ground of article 18(1)", async () => {
      const target = await create();
      await opened(target.adapter, async (storage) => {
        await storage.persons.restrict("c-1", {
          ground: "objection-pending",
          categories: null,
          since: new Date("2026-01-01T00:00:00.000Z"),
        });
        await storage.eventStore.append({
          aggregateType: "bounda",
          aggregateId: "c-1",
          expectedVersion: 0,
          events: (
            ["ProcessingRestricted", "ProcessingRestrictionLifted", "ProcessingRestricted"] as const
          ).map((type, index) => ({
            id: `r-${index + 1}`,
            aggregateType: "bounda",
            aggregateId: "c-1",
            version: index + 1,
            type,
            payload: { personId: "c-1" },
            timestamp: `2026-01-0${index + 1}T00:00:00.000Z`,
            metadata: {
              correlationId: "c",
              causationId: "c",
              depth: 0,
              schemaVersion: 1,
              system: true,
            },
            person: "c-1",
          })),
        });
      });
      const shape = await shapeOf(target, dialect);
      await target.execute(
        `DROP TABLE "${storageTableNameFor({ prefix: target.prefix, table: "restrictions" })}"`,
      );
      await target.execute(
        `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'storage' AND "version" >= 4`,
      );
      await opened(target.adapter, async (storage) => {
        expect(await storage.persons.restrictions("c-1")).toEqual([
          { ground: "accuracy-contested", category: null, since: "2026-01-01T00:00:00.000Z" },
        ]);
        const events = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
        expect(events.map(({ payload }) => payload)).toEqual([
          {
            personId: "c-1",
            ground: "accuracy-contested",
            categories: null,
            restrictions: [
              {
                ground: "accuracy-contested",
                categories: null,
                since: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
          {
            personId: "c-1",
            grounds: ["accuracy-contested"],
            categories: null,
            restrictions: [],
          },
          {
            personId: "c-1",
            ground: "accuracy-contested",
            categories: null,
            restrictions: [
              {
                ground: "accuracy-contested",
                categories: null,
                since: "2026-01-03T00:00:00.000Z",
              },
            ],
          },
        ]);
      });
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    it("takes in scheduled commands stored before their time was recorded, and letters before they named the state's person", async () => {
      const target = await create();
      await opened(target.adapter, async (storage) => {
        await storage.scheduler.schedule({
          dedupeKey: "k-1",
          command: testCommand("1"),
          executeAt: new Date("2026-01-02T00:00:00.000Z"),
          scheduledAt: new Date("2026-01-01T00:00:00.000Z"),
          context: testContext,
        });
        await storage.deadLetterStore.add(testDeadLetter("d-1"));
      });
      const shape = await shapeOf(target, dialect);
      const table = (name: "scheduledCommands" | "deadLetters") =>
        `"${storageTableNameFor({ prefix: target.prefix, table: name })}"`;
      await target.execute(
        `DROP INDEX "${storageTableNameFor({ prefix: target.prefix, table: "deadLetters" })}_state_person_idx"`,
      );
      await target.execute(`ALTER TABLE ${table("deadLetters")} DROP COLUMN "state_person"`);
      await target.execute(`ALTER TABLE ${table("scheduledCommands")} DROP COLUMN "scheduled_at"`);
      await target.execute(
        `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'storage' AND "version" >= 9`,
      );
      await opened(target.adapter, async (storage) => {
        const entry = await storage.scheduler.get("k-1");
        expect(entry).toMatchObject({ dedupeKey: "k-1" });
        expect(entry).not.toHaveProperty("scheduledAt");
        const letter = await storage.deadLetterStore.get("d-1");
        expect(letter).toMatchObject({ id: "d-1" });
        expect(letter).not.toHaveProperty("statePerson");
      });
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    it("adds, at migration 10, the table of the keys a reseal superseded, keeping everything else", async () => {
      const target = await create();
      await opened(target.adapter, (storage) => storage.checkpointStore.set("projection:x", 3));
      const shape = await shapeOf(target, dialect);
      await target.execute(
        `DROP TABLE "${storageTableNameFor({ prefix: target.prefix, table: "supersededKeys" })}"`,
      );
      await target.execute(
        `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'storage' AND "version" >= 10`,
      );
      await opened(target.adapter, async (storage) => {
        expect(await storage.checkpointStore.get("projection:x")).toBe(3);
        expect(await storage.personalKeys.countSuperseded()).toBe(0);
      });
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    it("adds, at its last migration, the table of the forgotten persons each recipient was listed with, keeping everything else", async () => {
      const target = await create();
      await opened(target.adapter, (storage) => storage.checkpointStore.set("projection:x", 3));
      const shape = await shapeOf(target, dialect);
      await target.execute(
        `DROP TABLE "${storageTableNameFor({ prefix: target.prefix, table: "forgottenRecipients" })}"`,
      );
      await target.execute(
        `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'storage' AND "version" = ${STORAGE_LATEST[dialect]}`,
      );
      await opened(target.adapter, async (storage) => {
        expect(await storage.checkpointStore.get("projection:x")).toBe(3);
        expect(await storage.recipients.forgottenCounts()).toEqual([]);
      });
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    it("removes, at the fifth version of the checkpoints, the handled restore's position, which its one row names now", async () => {
      const target = await create();
      await opened(target.adapter, async (storage) => {
        await storage.checkpointStore.set("runtime:restore-handled-at", 7);
        await storage.checkpointStore.set("runtime:restore-handled", 11);
        await storage.checkpointStore.set("projection:x", 3);
      });
      await target.execute(
        `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'checkpoints' AND "version" >= 5`,
      );
      await opened(target.adapter, async (storage) => {
        expect(await storage.checkpointStore.get("runtime:restore-handled-at")).toBe(0);
        expect(await storage.checkpointStore.get("runtime:restore-handled")).toBe(11);
        expect(await storage.checkpointStore.get("projection:x")).toBe(3);
      });
      expect(
        (await versionsOf(target)).filter(({ scope }) => scope === "checkpoints"),
      ).toHaveLength(5);
    });

    it("adds, at migration 11, whom else a letter's and a failure's work read, naming nobody there before", async () => {
      const target = await create();
      await opened(target.adapter, async (storage) => {
        await storage.deadLetterStore.add({ ...testDeadLetter("d-1"), person: "ana" });
        await storage.subscriberFailures.record({
          subscriber: "orders",
          position: 1,
          eventId: "e-1",
          eventType: "OrderPlaced",
          person: "ana",
          errorName: "Error",
          errorMessage: "boom",
          failedAt: "2026-01-01T00:00:00.000Z",
        });
      });
      const shape = await shapeOf(target, dialect);
      const table = (name: "subscriberFailures" | "deadLetters") =>
        `"${storageTableNameFor({ prefix: target.prefix, table: name })}"`;
      const named = (name: "personRows" | "deadLetters") =>
        storageTableNameFor({ prefix: target.prefix, table: name });
      if (dialect === "sqlite") {
        for (const event of ["insert", "update", "delete"]) {
          await target.execute(`DROP TRIGGER "${named("personRows")}_dead_letter_reads_${event}"`);
        }
      } else {
        await target.execute(`DROP INDEX "${named("deadLetters")}_read_persons_idx"`);
      }
      await target.execute(`ALTER TABLE ${table("deadLetters")} DROP COLUMN "read_persons"`);
      await target.execute(`ALTER TABLE ${table("subscriberFailures")} DROP COLUMN "read_persons"`);
      await target.execute(
        `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'storage' AND "version" >= 11`,
      );
      await opened(target.adapter, async (storage) => {
        const letter = await storage.deadLetterStore.get("d-1");
        expect(letter).toMatchObject({ id: "d-1", person: "ana" });
        expect(letter).not.toHaveProperty("readPersons");
        expect(await storage.subscriberFailures.get("orders")).not.toHaveProperty("readPersons");
        await storage.deadLetterStore.add({ ...testDeadLetter("d-2"), readPersons: ["bea"] });
        expect(
          (await storage.deadLetterStore.listByPerson({ person: "bea" })).map(({ id }) => id),
        ).toEqual(["d-2"]);
      });
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    it("takes in a database the current tables were created in before they were versioned", async () => {
      const target = await create();
      await opened(target.adapter, (storage) => storage.checkpointStore.set("projection:x", 3));
      const shape = await shapeOf(target, dialect);
      await target.execute(`DROP TABLE ${schemaMigrationsTableFor(target.prefix)}`);
      expect(
        await opened(target.adapter, (storage) => storage.checkpointStore.get("projection:x")),
      ).toBe(3);
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    it("converts only what a table lacks, from a database between releases", async () => {
      const fresh = await create();
      await opened(fresh.adapter, async () => undefined);
      const target = await create();
      const letter = {
        ...testDeadLetter("dl-1"),
        errorMessage: '"already" encoded',
        errorStack: "Error: x\n    at f",
        lastFailedAt: "2026-01-02T00:00:00.000Z",
      };
      const claim = { handler: "order.notify", eventId: "e-1" };
      await opened(target.adapter, async (storage) => {
        await storage.deadLetterStore.add(letter);
        await storage.deadLetterStore.updateStatus("dl-1", "discarded", new Date("2026-03-01"));
        await storage.inboxLedger.tryClaim({ ...claim, now: new Date(), leaseMs: 1_000 });
        await storage.inboxLedger.fail({ ...claim, error: "ValidationError" });
      });
      const { deadLetters } = earlierTablesFor(target.prefix);
      await target.execute(`DROP TABLE ${schemaMigrationsTableFor(target.prefix)}`);
      await target.execute(`DROP INDEX "${deadLetters.slice(1, -1)}_resolved_idx"`);
      await target.execute(`ALTER TABLE ${deadLetters} DROP COLUMN "resolved_at"`);
      await opened(target.adapter, async (storage) => {
        expect(await storage.deadLetterStore.get("dl-1")).toEqual({
          ...letter,
          status: "discarded",
          resolvedAt: "2026-01-02T00:00:00.000Z",
        });
        expect(await storage.inboxLedger.get(claim)).toMatchObject({
          lastError: "ValidationError",
        });
      });
      expect(await shapeOf(target, dialect)).toEqual(await shapeOf(fresh, dialect));
    });

    it("refuses tables older than 0.2.0, which had to be created again since", async () => {
      const target = await create();
      const { inbox } = earlierTablesFor(target.prefix);
      await target.execute(
        `CREATE TABLE ${inbox} ("subscriber" TEXT NOT NULL, "event_id" TEXT NOT NULL, PRIMARY KEY ("subscriber", "event_id"))`,
      );
      const shape = await shapeOf(target, dialect);
      const refused = target.adapter.createStorage();
      await expect(refused).rejects.toBeInstanceOf(ConfigurationError);
      await expect(refused).rejects.toThrow(/before 0\.2\.0/);
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    it("versions a forget ledger's table in its own scope where the ledger lives", async () => {
      const target = await create();
      const ledger = await target.adapter.createForgetLedger({ tenant: "t-1" });
      try {
        await ledger.append([
          {
            personId: "p-1",
            eventId: "e-1",
            forgottenAt: "2026-01-01T00:00:00.000Z",
            categories: null,
            reason: "requested",
          },
        ]);
      } finally {
        await ledger.close?.();
      }
      expect((await versionsOf(target)).map(({ scope, version }) => ({ scope, version }))).toEqual([
        { scope: "forget-ledger", version: 1 },
        { scope: "forget-ledger", version: 2 },
        { scope: "forget-ledger", version: 3 },
        { scope: "forget-ledger", version: 4 },
        { scope: "forget-ledger", version: 5 },
        { scope: "forget-ledger", version: 6 },
        { scope: "forget-ledger", version: 7 },
        { scope: "forget-ledger", version: 8 },
        { scope: "forget-ledger", version: 9 },
        { scope: "forget-ledger", version: 10 },
        { scope: "forget-ledger", version: 11 },
        { scope: "forget-ledger", version: 12 },
        { scope: "forget-ledger", version: 13 },
      ]);
    });

    it("moves what an app that names no tenant kept under the empty name to DEFAULT_TENANT, one of each", async () => {
      const target = await create();
      const table = quoteIdentifier(
        storageTableNameFor({ prefix: target.prefix, table: "forgetLedger" }),
      );
      const marks = forgetLedgerMarksTableFor(table);
      const fence = forgetLedgerFenceTableFor(table);
      const migrated = await target.adapter.createForgetLedger({ tenant: "t-1" });
      try {
        await migrated.read({ limit: 1 });
      } finally {
        await migrated.close?.();
      }
      // As a release before the ninth version left them: the app that names no tenant under "",
      // and `bounda export-tenant default` under DEFAULT_TENANT, both of the same tenant.
      const entryRow = (tenant: string, eventId: string) =>
        `('${tenant}', '${eventId}', 'p-${eventId}', '2026-01-01T00:00:0${eventId.slice(-1)}.000Z')`;
      await target.execute(
        `INSERT INTO ${table} ("tenant", "event_id", "person", "forgotten_at") VALUES ${[
          entryRow("", "e-1"),
          entryRow("", "e-2"),
          entryRow(DEFAULT_TENANT, "e-2"),
          entryRow(DEFAULT_TENANT, "e-3"),
          entryRow("t-1", "e-4"),
        ].join(", ")}`,
      );
      await target.execute(
        `INSERT INTO ${marks} ("tenant", "name", "value") VALUES ('', 'restore', 5), ('', 'reconciled', 3), ('${DEFAULT_TENANT}', 'restore', 2), ('${DEFAULT_TENANT}', 'flushed', 7)`,
      );
      await target.execute(
        `INSERT INTO ${fence} ("scope", "tenant", "state", "since") VALUES ('', '${DEFAULT_TENANT}', 'frozen', '2026-01-01T00:00:00.000Z'), ('${DEFAULT_TENANT}', '${DEFAULT_TENANT}', 'frozen', '2026-01-02T00:00:00.000Z')`,
      );
      await target.execute(
        `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'forget-ledger' AND "version" >= 9`,
      );
      const ledger = await target.adapter.createForgetLedger({ tenant: DEFAULT_TENANT });
      try {
        expect((await ledger.read({ limit: 10 })).map(({ eventId }) => eventId)).toEqual([
          "e-1",
          "e-2",
          "e-3",
        ]);
        const epoch = "1970-01-01T00:00:00.000Z";
        expect([
          await ledger.readMark("restore"),
          await ledger.readMark("reconciled"),
          await ledger.readMark("flushed"),
        ]).toEqual([
          [{ value: 5, raisedAt: epoch }],
          [{ value: 3, raisedAt: epoch }],
          [{ value: 7, raisedAt: epoch }],
        ]);
        expect(await ledger.fence.read()).toEqual({
          state: "frozen",
          tenant: DEFAULT_TENANT,
          since: "2026-01-01T00:00:00.000Z",
        });
      } finally {
        await ledger.close?.();
      }
      const left = await target.execute(
        `SELECT "tenant" FROM ${table} WHERE "tenant" = '' UNION ALL SELECT "tenant" FROM ${marks} WHERE "tenant" = '' UNION ALL SELECT "scope" FROM ${fence} WHERE "scope" = ''`,
      );
      expect(left).toEqual([]);
      expect(
        (await target.execute(`SELECT "event_id" FROM ${table} WHERE "tenant" = 't-1'`)).map(
          ({ event_id }) => event_id,
        ),
      ).toEqual(["e-4"]);
    });

    it("reads every entry written before the tenth version as committed, and keeps telling intentions apart after", async () => {
      const target = await create();
      const table = quoteIdentifier(
        storageTableNameFor({ prefix: target.prefix, table: "forgetLedger" }),
      );
      const migrated = await target.adapter.createForgetLedger({ tenant: "t-1" });
      try {
        await migrated.read({ limit: 1 });
      } finally {
        await migrated.close?.();
      }
      // As a release before the tenth version left them: no column, and an entry per forgetting.
      await target.execute(`ALTER TABLE ${table} DROP COLUMN "committed"`);
      await target.execute(
        `INSERT INTO ${table} ("tenant", "event_id", "person", "forgotten_at") VALUES ('t-1', 'e-1', 'p-1', '2026-01-01T00:00:01.000Z')`,
      );
      await target.execute(
        `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'forget-ledger' AND "version" >= 10`,
      );
      const ledger = await target.adapter.createForgetLedger({ tenant: "t-1" });
      try {
        await ledger.append([
          {
            personId: "p-2",
            eventId: "e-2",
            forgottenAt: "2026-01-01T00:00:02.000Z",
            categories: null,
            reason: "requested",
            committed: false,
          },
        ]);
        expect(
          (await ledger.read({ limit: 10 })).map(({ eventId, committed }) => ({
            eventId,
            committed,
          })),
        ).toEqual([
          { eventId: "e-1", committed: undefined },
          { eventId: "e-2", committed: false },
        ]);
      } finally {
        await ledger.close?.();
      }
    });

    it("keeps where the database stood when an intention was written from the eleventh version, and nothing for an entry before", async () => {
      const target = await create();
      const table = quoteIdentifier(
        storageTableNameFor({ prefix: target.prefix, table: "forgetLedger" }),
      );
      const migrated = await target.adapter.createForgetLedger({ tenant: "t-1" });
      try {
        await migrated.read({ limit: 1 });
      } finally {
        await migrated.close?.();
      }
      await target.execute(`ALTER TABLE ${table} DROP COLUMN "reached"`);
      await target.execute(
        `INSERT INTO ${table} ("tenant", "event_id", "person", "forgotten_at", "committed") VALUES ('t-1', 'e-1', 'p-1', '2026-01-01T00:00:01.000Z', 0)`,
      );
      await target.execute(
        `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'forget-ledger' AND "version" >= 11`,
      );
      const ledger = await target.adapter.createForgetLedger({ tenant: "t-1" });
      try {
        const intention = {
          personId: "p-2",
          eventId: "e-2",
          forgottenAt: "2026-01-01T00:00:02.000Z",
          categories: null,
          reason: "requested" as const,
          committed: false as const,
          reached: { position: 9_007_199_254_740_000, generation: 3 },
        };
        await ledger.append([intention]);
        // Committed later, it keeps where the database stood.
        const { committed: _, reached: __, ...copied } = intention;
        await ledger.append([copied]);
        expect(await ledger.read({ limit: 10 })).toEqual([
          {
            personId: "p-1",
            eventId: "e-1",
            forgottenAt: "2026-01-01T00:00:01.000Z",
            categories: null,
            reason: "requested",
            committed: false,
          },
          { ...copied, reached: intention.reached },
        ]);
      } finally {
        await ledger.close?.();
      }
    });

    it("reads a mark raised before the twelfth version as raised at the epoch, and keeps when each value was first raised after", async () => {
      const target = await create();
      const table = quoteIdentifier(
        storageTableNameFor({ prefix: target.prefix, table: "forgetLedger" }),
      );
      const marks = forgetLedgerMarksTableFor(table);
      const migrated = await target.adapter.createForgetLedger({ tenant: "t-1" });
      try {
        await migrated.read({ limit: 1 });
      } finally {
        await migrated.close?.();
      }
      await target.execute(`ALTER TABLE ${marks} DROP COLUMN "raised_at"`);
      await target.execute(
        `INSERT INTO ${marks} ("tenant", "name", "value") VALUES ('t-1', 'restore', 4)`,
      );
      await target.execute(
        `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'forget-ledger' AND "version" >= 12`,
      );
      const ledger = await target.adapter.createForgetLedger({ tenant: "t-1" });
      try {
        expect(await ledger.readMark("restore")).toEqual([
          { value: 4, raisedAt: "1970-01-01T00:00:00.000Z" },
        ]);
        await ledger.raiseMark("restore", { value: 5, raisedAt: "2026-01-01T00:00:05.000Z" });
        await ledger.raiseMark("restore", { value: 5, raisedAt: "2026-01-01T00:00:06.000Z" });
        expect(await ledger.readMark("restore")).toEqual([
          { value: 5, raisedAt: "2026-01-01T00:00:05.000Z" },
        ]);
      } finally {
        await ledger.close?.();
      }
    });

    it("keeps from the thirteenth version the transfer each disclosure rested on, one recorded before taking it from its country and safeguard once", async () => {
      const target = await create();
      const table = quoteIdentifier(
        storageTableNameFor({ prefix: target.prefix, table: "forgetLedger" }),
      );
      const migrated = await target.adapter.createForgetLedger({ tenant: "t-1" });
      try {
        await migrated.read({ limit: 1 });
      } finally {
        await migrated.close?.();
      }
      const identity = { port: "customer.mailer", recipient: "Mailchimp", kind: "processor" };
      const scc = {
        safeguard: "standard-contractual-clauses",
        article: "46(2)(c)",
        regime: "US",
      } as const;
      const legacy = JSON.stringify({
        ...identity,
        country: "US",
        safeguard: scc.safeguard,
        category: "contact",
      });
      // Kept with another regime than the lists give now: it stays as it was kept.
      const kept = {
        ...identity,
        country: "US",
        transfer: { ...scc, regime: "EEA" },
        category: "a",
      };
      const unreadable = JSON.stringify({ ...identity, country: "US", category: 1 });
      const insert = (rows: readonly (readonly [string, string, string | null])[]) =>
        target.execute(
          `INSERT INTO ${table} ("tenant", "event_id", "person", "forgotten_at", "disclosure") VALUES ${rows
            .map(
              ([tenant, eventId, disclosure]) =>
                `('${tenant}', '${eventId}', 'p-1', '2026-01-01T00:00:01.000Z', ${disclosure === null ? "NULL" : `'${disclosure}'`})`,
            )
            .join(", ")}`,
        );
      await insert([
        ["t-1", "e-1", legacy],
        [
          "t-1",
          "e-2",
          JSON.stringify({ ...identity, country: "FR", safeguard: null, category: "b" }),
        ],
        ["t-1", "e-3", JSON.stringify(kept)],
        ["t-1", "e-4", null],
        ["t-3", "e-1", unreadable],
        ["t-3", "e-2", "not json"],
      ]);
      // More than one page of them, past the first tenant's.
      for (const half of [0, 1]) {
        await insert(
          Array.from({ length: 300 }, (_, index) => [
            "t-2",
            `e-${String(half * 300 + index).padStart(3, "0")}`,
            legacy,
          ]),
        );
      }
      await target.execute(
        `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'forget-ledger' AND "version" = 13`,
      );
      const ledger = await target.adapter.createForgetLedger({ tenant: "t-1" });
      try {
        const entry = (eventId: string) => ({
          personId: "p-1",
          eventId,
          forgottenAt: "2026-01-01T00:00:01.000Z",
          categories: null,
          reason: "requested",
        });
        expect(await ledger.read({ limit: 10 })).toEqual([
          {
            ...entry("e-1"),
            disclosure: { ...identity, country: "US", transfer: scc, category: "contact" },
          },
          {
            ...entry("e-2"),
            disclosure: { ...identity, country: "FR", transfer: null, category: "b" },
          },
          { ...entry("e-3"), disclosure: kept },
          entry("e-4"),
        ]);
        const rows = await target.execute(
          `SELECT "tenant", "disclosure" FROM ${table} WHERE "tenant" <> 't-1' ORDER BY "tenant", "event_id"`,
        );
        expect(rows).toHaveLength(602);
        // What it cannot read, as it was.
        expect(rows.slice(-2).map(({ disclosure }) => disclosure)).toEqual([
          unreadable,
          "not json",
        ]);
        for (const { disclosure } of rows.slice(0, -2)) {
          expect(JSON.parse(String(disclosure))).toEqual({
            ...identity,
            country: "US",
            transfer: scc,
            category: "contact",
          });
        }
        // Written by a version before, as one still running beside it may.
        await insert([["t-1", "e-5", legacy]]);
        expect((await ledger.read({ limit: 10 })).at(-1)).toEqual({
          ...entry("e-5"),
          disclosure: { ...identity, country: "US", transfer: scc, category: "contact" },
        });
      } finally {
        await ledger.close?.();
      }
      const other = await target.adapter.createForgetLedger({ tenant: "t-3" });
      try {
        await expect(other.read({ limit: 10 })).rejects.toThrow(
          "The forget ledger's entry e-1 holds a disclosure it cannot read",
        );
      } finally {
        await other.close?.();
      }
    });

    // An open fence is no row; of two raised, the ninth version keeps the forgotten one, or of the
    // same state the earlier, under DEFAULT_TENANT.
    const frozenOn = (day: number): LegacyFence => ({ state: "frozen", day });
    const forgottenOn = (day: number): LegacyFence => ({ state: "forgotten", day });
    const fencePairs: readonly (readonly [
      string,
      LegacyFence | null,
      LegacyFence | null,
      LegacyFence | null,
    ])[] = [
      ["both open", null, null, null],
      ["frozen under the empty name, open under DEFAULT_TENANT", frozenOn(1), null, frozenOn(1)],
      [
        "forgotten under the empty name, open under DEFAULT_TENANT",
        forgottenOn(1),
        null,
        forgottenOn(1),
      ],
      ["open under the empty name, frozen under DEFAULT_TENANT", null, frozenOn(1), frozenOn(1)],
      [
        "open under the empty name, forgotten under DEFAULT_TENANT",
        null,
        forgottenOn(1),
        forgottenOn(1),
      ],
      ["both frozen, the empty name's earlier", frozenOn(1), frozenOn(2), frozenOn(1)],
      ["both frozen, DEFAULT_TENANT's earlier", frozenOn(2), frozenOn(1), frozenOn(1)],
      ["both frozen at once", frozenOn(1), frozenOn(1), frozenOn(1)],
      [
        "frozen under the empty name, forgotten under DEFAULT_TENANT",
        frozenOn(1),
        forgottenOn(2),
        forgottenOn(2),
      ],
      [
        "forgotten under the empty name, frozen under DEFAULT_TENANT",
        forgottenOn(2),
        frozenOn(1),
        forgottenOn(2),
      ],
      ["both forgotten, the empty name's earlier", forgottenOn(1), forgottenOn(2), forgottenOn(1)],
      ["both forgotten, DEFAULT_TENANT's earlier", forgottenOn(2), forgottenOn(1), forgottenOn(1)],
    ];
    it.each(fencePairs)(
      "keeps one fence of the tenant through the ninth version: %s",
      async (_, legacy, named, kept) => {
        const target = await create();
        const table = quoteIdentifier(
          storageTableNameFor({ prefix: target.prefix, table: "forgetLedger" }),
        );
        const fence = forgetLedgerFenceTableFor(table);
        const migrated = await target.adapter.createForgetLedger({ tenant: DEFAULT_TENANT });
        try {
          await migrated.read({ limit: 1 });
        } finally {
          await migrated.close?.();
        }
        for (const [scope, raised] of [
          ["", legacy],
          [DEFAULT_TENANT, named],
        ] as const) {
          if (raised === null) continue;
          await target.execute(
            `INSERT INTO ${fence} ("scope", "tenant", "state", "since") VALUES ('${scope}', '${scope}', '${raised.state}', '${sinceOn(raised.day)}')`,
          );
        }
        await target.execute(
          `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'forget-ledger' AND "version" >= 9`,
        );
        const ledger = await target.adapter.createForgetLedger({ tenant: DEFAULT_TENANT });
        try {
          expect(await ledger.fence.read()).toEqual(
            kept === null
              ? { state: "open" }
              : { state: kept.state, tenant: DEFAULT_TENANT, since: sinceOn(kept.day) },
          );
        } finally {
          await ledger.close?.();
        }
        expect(await target.execute(`SELECT "scope" FROM ${fence}`)).toEqual(
          kept === null ? [] : [{ scope: DEFAULT_TENANT }],
        );
      },
    );

    it("keeps a tenant frozen through the ninth version when only DEFAULT_TENANT's fence was raised", async () => {
      const target = await create();
      const table = quoteIdentifier(
        storageTableNameFor({ prefix: target.prefix, table: "forgetLedger" }),
      );
      // The database's fence and the tenant's keys in memory, the ledger in this database.
      const storage = memory();
      const boot = (tenant?: string) =>
        createApp({
          registry: { aggregates: {}, readModels: {} } as unknown as Registry,
          config: {
            storage,
            runtime: { personalData: { forgetLedger: { store: target.adapter } } },
          },
          clock: createFixedClock(new Date("2026-03-01T00:00:00.000Z")),
          ...(tenant === undefined ? {} : { tenant }),
        });
      // What `bounda freeze-tenant default` raised over a release that kept the app that names no
      // tenant, and its entry, under the empty name.
      const named = await boot(DEFAULT_TENANT);
      await named.freezeTenant(DEFAULT_TENANT);
      await named.stop();
      await target.execute(
        `INSERT INTO ${table} ("tenant", "event_id", "person", "forgotten_at") VALUES ('', 'e-1', 'ana', '2026-01-01T00:00:00.000Z')`,
      );
      await target.execute(
        `DELETE FROM ${schemaMigrationsTableFor(target.prefix)} WHERE "scope" = 'forget-ledger' AND "version" >= 9`,
      );
      const unnamed = await boot();
      try {
        const parts: TenantExportPart[] = [];
        for await (const part of await unnamed.exportTenant(DEFAULT_TENANT)) parts.push(part);
        expect(
          parts.flatMap((part) => (part.kind === "forgetLedgerEntry" ? [part.entry.eventId] : [])),
        ).toEqual(["e-1"]);
        const ledger = await target.adapter.createForgetLedger({ tenant: DEFAULT_TENANT });
        try {
          await expect(
            ledger.append([
              {
                personId: "bo",
                eventId: "e-2",
                forgottenAt: "2026-03-01T00:00:00.000Z",
                categories: null,
                reason: "requested",
              },
            ]),
          ).rejects.toBeInstanceOf(TenantFrozenError);
          expect((await ledger.read({ limit: 10 })).map(({ eventId }) => eventId)).toEqual(["e-1"]);
        } finally {
          await ledger.close?.();
        }
      } finally {
        await unnamed.stop();
      }
    });

    it("versions a tenant key store's table in a database of its own, once it is first used", async () => {
      const target = await create();
      const store = await target.adapter.createTenantKeyStore();
      try {
        expect(await versionsOf(target).catch(() => [])).toEqual([]);
        expect(await store.get("acme")).toBeNull();
      } finally {
        await store.close?.();
      }
      expect((await versionsOf(target)).map(({ scope, version }) => ({ scope, version }))).toEqual([
        { scope: "tenant-keys", version: 1 },
      ]);
    });

    it("versions the checkpoints of read models in a database of their own", async () => {
      const target = await create();
      const readModel = await target.adapter.createReadModel({
        name: "orderSummary",
        fields: contractFields,
        logger: silentLogger,
      });
      await readModel.close();
      expect((await versionsOf(target)).map(({ scope, version }) => ({ scope, version }))).toEqual([
        { scope: "checkpoints", version: 1 },
        { scope: "checkpoints", version: 2 },
        { scope: "checkpoints", version: 3 },
        { scope: "checkpoints", version: 4 },
        { scope: "checkpoints", version: 5 },
      ]);
    });
  });
};
