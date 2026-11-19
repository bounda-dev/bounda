import { describe, expect, it } from "vitest";
import { ConfigurationError, StorageSchemaTooNewError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import type { Adapter, Storage } from "../adapter.ts";
import { storageTableNameFor } from "../sql/identifiers.ts";
import { schemaMigrationsTableFor, schemaMigrationsTableStatement } from "../sql/migrations.ts";
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
];

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
        LATEST,
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
        { scope: "storage", version: 0, latest: 11 },
        { scope: "checkpoints", version: 0, latest: 3 },
        { scope: "forget-ledger", version: 0, latest: 7 },
        { scope: "tenant-keys", version: 0, latest: 1 },
      ]);
      expect(await shapeOf(target, dialect)).toEqual([]);
      expect(await target.adapter.migrate(["checkpoints"])).toEqual([
        { scope: "storage", version: 0, latest: 11 },
        { scope: "checkpoints", version: 3, latest: 3 },
        { scope: "forget-ledger", version: 0, latest: 7 },
        { scope: "tenant-keys", version: 0, latest: 1 },
      ]);
      expect(await target.adapter.migrate(["storage", "forget-ledger", "tenant-keys"])).toEqual([
        { scope: "storage", version: 11, latest: 11 },
        { scope: "checkpoints", version: 3, latest: 3 },
        { scope: "forget-ledger", version: 7, latest: 7 },
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
        latest: 3,
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
        LATEST,
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
        supported: 11,
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
        ).toEqual(LATEST);
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
      ]);
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
      ]);
    });
  });
};
