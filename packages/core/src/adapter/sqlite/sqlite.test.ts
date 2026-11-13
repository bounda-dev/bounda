/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConfigurationError, RebuildSupersededError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { type FieldsRecord, fieldBuilder as f } from "../../modules/view.ts";
import type { SqlDatabase } from "../sql/database.ts";
import type { SqlExecutor } from "../sql/sql-table.ts";
import { DEFAULT_PERSONAL_CATEGORY, type KeyedPerson } from "../storage/personal-key-store.ts";
import {
  testKeyedPerson as held,
  testPersonalKey as key,
  testCommand,
  testContext,
  testDeadLetter,
  testOutcome,
} from "../testing/fixtures.ts";
import {
  type ContractRow,
  checkpointStoreContract,
  contractFields,
  deadLetterStoreContract,
  eventStoreContract,
  forgetLedgerContract,
  idempotencyStoreContract,
  inboxLedgerContract,
  inspectionContract,
  pendingEvent,
  personalKeyStoreContract,
  personStoreContract,
  readModelRebuildContract,
  readModelTransactionContract,
  restrictedReadsContract,
  schedulerContract,
  snapshotStoreContract,
  storageSchemaContract,
  storageTransactionContract,
  subscriberFailureStoreContract,
  tableContract,
  viewContract,
} from "../testing/index.ts";
import { createSqliteEventStore } from "./event-store.ts";
import { createSqliteAdapter } from "./index.ts";
import { storageTablesFor } from "./schema.ts";

const { events: table, personalKeys, restrictions } = storageTablesFor("bounda_");
const eventTables = { table, personalKeys, restrictions };

const bind = (params: readonly unknown[]): SQLInputValue[] =>
  params.map((value) => (typeof value === "boolean" ? Number(value) : value)) as SQLInputValue[];

const nodeSqlite = (
  db = new DatabaseSync(":memory:"),
  tablePrefix = "bounda_",
  statements: string[] = [],
) => {
  const executor: SqlExecutor = {
    run: async (sql, params) => {
      statements.push(sql);
      db.prepare(sql).run(...bind(params));
    },
    all: async (sql, params) => {
      statements.push(sql);
      return db.prepare(sql).all(...bind(params)) as Record<string, unknown>[];
    },
  };
  let queue: Promise<unknown> = Promise.resolve();
  const database: SqlDatabase = {
    ...executor,
    write: (work) => {
      const next = queue.then(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await work({ ...executor, raw: db });
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
  let uses = 0;
  const adapter = createSqliteAdapter({
    name: "node-sqlite",
    options: { tablePrefix },
    tablePrefix,
    acquire: () => {
      uses += 1;
      return { db: database, raw: db };
    },
    release: async () => {
      uses -= 1;
    },
  });
  return { adapter, db, uses: () => uses };
};

const storage = () => nodeSqlite().adapter.createStorage();

const recordingLogger = () => {
  const logs: unknown[] = [];
  return {
    logs,
    logger: {
      ...silentLogger,
      info: (message: string, fields?: unknown) => {
        logs.push([message, fields]);
      },
    },
  };
};

const tableNames = (db: DatabaseSync, prefix: string): unknown[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ORDER BY name")
    .all(`${prefix}%`)
    .map((row) => row.name);

describe("the SQLite stores on node:sqlite", () => {
  eventStoreContract({ create: storage });
  checkpointStoreContract({ create: async () => (await storage()).checkpointStore });
  inboxLedgerContract({ create: async () => (await storage()).inboxLedger });
  deadLetterStoreContract({ create: async () => (await storage()).deadLetterStore });
  schedulerContract({ create: async () => (await storage()).scheduler });
  idempotencyStoreContract({ create: storage });
  snapshotStoreContract({ create: storage });
  storageTransactionContract({ create: storage });
  personalKeyStoreContract({ create: async () => storage() });
  personStoreContract({ create: async () => (await storage()).persons });
  inspectionContract({ create: async () => nodeSqlite().adapter });
  subscriberFailureStoreContract({ create: async () => (await storage()).subscriberFailures });
  forgetLedgerContract({
    create: async () => {
      const { adapter } = nodeSqlite();
      return (tenant) => adapter.createForgetLedger({ tenant });
    },
  });
  tableContract({
    create: async () =>
      (
        await nodeSqlite().adapter.createReadModel<ContractRow>({
          name: "orderSummary",
          fields: contractFields,
          logger: silentLogger,
        })
      ).table,
  });
  viewContract({ create: async () => nodeSqlite().adapter });
  readModelRebuildContract({ create: async () => nodeSqlite().adapter });
  readModelTransactionContract({
    create: async () => nodeSqlite().adapter,
    locking: "single-writer",
  });
  restrictedReadsContract({ create: async () => nodeSqlite().adapter });
  storageSchemaContract({
    create: async () => {
      const { adapter, db } = nodeSqlite();
      return {
        adapter,
        prefix: "bounda_",
        execute: async (statement) => db.prepare(statement).all() as Record<string, unknown>[],
      };
    },
    dialect: "sqlite",
  });
});

describe("the person index of the SQLite stores", () => {
  const indexed = (db: DatabaseSync): unknown[] =>
    db
      .prepare('SELECT "person", "store", "row" FROM "bounda_person_rows" ORDER BY 1, 2, 3')
      .all()
      .map((row) => [row.person, row.store, row.row]);

  it("keeps who each row names as its persons say, from its first write to its removal", async () => {
    const { adapter, db } = nodeSqlite();
    const storage = await adapter.createStorage();
    await storage.personalKeys.add("c-1", DEFAULT_PERSONAL_CATEGORY, key("1"));
    await storage.personalKeys.add("c-2", DEFAULT_PERSONAL_CATEGORY, key("2"));
    await storage.snapshotStore.put({
      aggregateType: "customer",
      aggregateId: "c-1",
      version: 1,
      fingerprint: "s",
      state: "{}",
      persons: [held("c-1", "1"), held("c-1", null)],
    });
    await storage.idempotencyStore.put({
      key: "i",
      fingerprint: "f",
      outcome: testOutcome("1"),
      expiresAt: "2026-01-02T00:00:00.000Z",
      persons: [held("c-2", "2")],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const schedule = (persons: readonly KeyedPerson[]) =>
      storage.scheduler.schedule({
        dedupeKey: "s",
        command: testCommand("1"),
        executeAt: new Date("2026-01-01T00:00:00.000Z"),
        context: testContext,
        persons,
      });
    await schedule([held("c-1", "1")]);
    await storage.deadLetterStore.add({
      ...testDeadLetter("d"),
      kind: "scheduled",
      persons: [held("c-1", "1"), held("c-2", "2")],
    });
    await storage.deadLetterStore.add(testDeadLetter("unnamed"));
    expect(indexed(db)).toEqual([
      ["c-1", "dead_letters", '["d"]'],
      ["c-1", "scheduled_commands", '["s"]'],
      ["c-1", "snapshots", '["customer","c-1"]'],
      ["c-2", "dead_letters", '["d"]'],
      ["c-2", "idempotency_keys", '["i"]'],
    ]);

    await schedule([held("c-2", "2")]);
    await storage.deadLetterStore.updateStatus("d", "retried", new Date());
    expect(indexed(db)).toContainEqual(["c-2", "scheduled_commands", '["s"]']);
    expect(indexed(db)).not.toContainEqual(["c-1", "scheduled_commands", '["s"]']);
    expect(indexed(db)).toContainEqual(["c-1", "dead_letters", '["d"]']);

    await storage.snapshotStore.remove({ aggregateType: "customer", aggregateId: "c-1" });
    await storage.idempotencyStore.purge({ now: new Date("2026-01-03T00:00:00.000Z") });
    await storage.scheduler.cancel("s");
    await storage.deadLetterStore.remove("d");
    expect(indexed(db)).toEqual([]);
  });

  it("rewrites a row's references when its persons are written again, whatever writes them", async () => {
    const { adapter, db } = nodeSqlite();
    const storage = await adapter.createStorage();
    await storage.deadLetterStore.add({ ...testDeadLetter("d"), persons: [held("c-1", "1")] });
    db.prepare('UPDATE "bounda_dead_letters" SET "persons" = ? WHERE "id" = ?').run(
      JSON.stringify([held("c-2", "2"), held("c-3", "3")]),
      "d",
    );
    expect(indexed(db)).toEqual([
      ["c-2", "dead_letters", '["d"]'],
      ["c-3", "dead_letters", '["d"]'],
    ]);
    expect((await storage.deadLetterStore.listByPerson("c-3")).map(({ id }) => id)).toEqual(["d"]);
    expect(await storage.deadLetterStore.listByPerson("c-1")).toEqual([]);
  });

  // The query plan of every statement `work` prepares.
  const plansOf = async (
    db: DatabaseSync,
    work: () => Promise<unknown>,
  ): Promise<readonly (readonly [string, readonly string[]])[]> => {
    const prepare = db.prepare.bind(db);
    const seen: string[] = [];
    db.prepare = (sql: string) => {
      seen.push(sql);
      return prepare(sql);
    };
    try {
      await work();
    } finally {
      db.prepare = prepare;
    }
    return seen.map((sql) => [
      sql,
      prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => String(row.detail)),
    ]);
  };

  // A row's own `persons`, or the fingerprints a forget keeps, are read through `json_each`, a scan
  // of the one value it is given, never of a store.
  const scans = (plan: readonly string[]): readonly string[] =>
    plan.filter((step) => step.startsWith("SCAN") && !step.includes("VIRTUAL TABLE"));

  it("finds the rows that name a person by index, never reading every row of a store", async () => {
    const { adapter, db } = nodeSqlite();
    const storage = await adapter.createStorage();
    const plans = await plansOf(db, async () => {
      await storage.snapshotStore.forget("c-1");
      await storage.idempotencyStore.forget("c-1");
      await storage.scheduler.listByPerson("c-1");
      await storage.scheduler.forget("c-1");
      await storage.deadLetterStore.listByPerson("c-1");
      await storage.deadLetterStore.forget("c-1");
    });
    const lookups = plans.filter(([sql]) => sql.includes("bounda_person_rows"));
    expect(lookups).toHaveLength(6);
    for (const [, plan] of lookups) expect(scans(plan)).toEqual([]);
  });

  it("removes a row's references by index when the row goes", async () => {
    const { adapter, db } = nodeSqlite();
    await adapter.createStorage();
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM "bounda_person_rows" WHERE "store" = 'dead_letters' AND "row" = '["d"]'`,
      )
      .all()
      .map((row) => String(row.detail));
    expect(plan).toEqual([expect.stringContaining("bounda_person_rows_row_idx")]);
  });

  it("finds and purges the resolved dead letters by index", async () => {
    const { adapter, db } = nodeSqlite();
    const storage = await adapter.createStorage();
    const plans = await plansOf(db, async () => {
      await storage.deadLetterStore.firstResolvedAt();
      await storage.deadLetterStore.purge({ resolvedBy: new Date(), limit: 1 });
    });
    expect(plans).toHaveLength(2);
    for (const [, plan] of plans) {
      expect(plan).toContainEqual(expect.stringContaining("bounda_dead_letters_resolved_idx"));
      expect(scans(plan)).toEqual([]);
    }
  });
});

describe("the SQLite event store", () => {
  it("never reports a version past the events a load from a later version returns", async () => {
    const { adapter, db } = nodeSqlite();
    const storage = await adapter.createStorage();
    const stream = { aggregateType: "order", aggregateId: "1" };
    await storage.eventStore.append({
      ...stream,
      expectedVersion: 0,
      events: [1, 2].map((version) => pendingEvent({ aggregateId: "1", version })),
    });
    // An append lands between the first and the second statement of the load.
    let statements = 0;
    const racing: SqlDatabase = {
      run: async (sql, params) => {
        db.prepare(sql).run(...bind(params));
      },
      all: async (sql, params) => {
        statements += 1;
        if (statements === 2) {
          await storage.eventStore.append({
            ...stream,
            expectedVersion: 2,
            events: [pendingEvent({ aggregateId: "1", version: 3 })],
          });
        }
        return db.prepare(sql).all(...bind(params)) as Record<string, unknown>[];
      },
      write: () => Promise.reject(new Error("not written here")),
    };
    const store = createSqliteEventStore({ db: racing, ...eventTables });
    const loaded = await store.load({ ...stream, fromVersion: 2 });
    expect(loaded.events.map((event) => event.version)).toEqual([2]);
    expect(loaded.version).toBe(2);
    expect(statements).toBe(2);
  });

  it("reads a load from the first event, or from past the head, in one statement", async () => {
    const { adapter, db } = nodeSqlite();
    const storage = await adapter.createStorage();
    const stream = { aggregateType: "order", aggregateId: "1" };
    await storage.eventStore.append({
      ...stream,
      expectedVersion: 0,
      events: [1, 2].map((version) => pendingEvent({ aggregateId: "1", version })),
    });
    let statements = 0;
    const counting: SqlDatabase = {
      run: async () => {},
      all: async (sql, params) => {
        statements += 1;
        return db.prepare(sql).all(...bind(params)) as Record<string, unknown>[];
      },
      write: () => Promise.reject(new Error("not written here")),
    };
    const store = createSqliteEventStore({ db: counting, ...eventTables });
    expect(await store.load(stream)).toMatchObject({ version: 2 });
    expect(statements).toBe(1);
    expect(await store.load({ ...stream, fromVersion: 1 })).toMatchObject({ version: 2 });
    expect(statements).toBe(2);
    expect(await store.load({ ...stream, fromVersion: 3 })).toEqual({ events: [], version: 2 });
    expect(statements).toBe(3);
  });
});

describe("createSqliteAdapter", () => {
  it("is an adapter with the name and options it was given", () => {
    const { adapter } = nodeSqlite(undefined, "x_");
    expect(adapter).toMatchObject({
      kind: "bounda-adapter",
      name: "node-sqlite",
      options: { tablePrefix: "x_" },
    });
  });

  it("acquires the connection once per storage, read model and rebuild, and releases each", async () => {
    const { adapter, uses } = nodeSqlite();
    const opened = await adapter.createStorage();
    const readModel = await adapter.createReadModel({
      name: "orderSummary",
      fields: contractFields,
      logger: silentLogger,
    });
    const rebuild = await adapter.rebuildReadModel({
      name: "orderSummary",
      fields: contractFields,
      logger: silentLogger,
      progress: "rebuild:orderSummary:1",
    });
    expect(uses()).toBe(3);
    await rebuild.abort();
    await readModel.close();
    await opened.close();
    expect(uses()).toBe(0);
  });

  it("releases the connection of a storage, read model or rebuild that fails to open", async () => {
    const { adapter, db, uses } = nodeSqlite();
    const orders = { id: f.string().primaryKey(), total: f.number() };
    await (
      await adapter.createReadModel({ name: "orders", fields: orders, logger: silentLogger })
    ).close();
    const narrower = { id: f.string().primaryKey() };
    await expect(
      adapter.createReadModel({ name: "orders", fields: narrower, logger: silentLogger }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      adapter.rebuildReadModel({
        name: "orders",
        fields: { id: f.string().primaryKey(), "not an identifier": f.string() },
        logger: silentLogger,
        progress: "rebuild:orders:1",
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    db.close();
    await expect(adapter.createStorage()).rejects.toThrow(/not open/);
    expect(uses()).toBe(0);
  });

  it("releases a rebuild's connection when it commits or pauses too", async () => {
    const { adapter, uses } = nodeSqlite();
    const rebuild = (progress: string) =>
      adapter.rebuildReadModel({
        name: "orderSummary",
        fields: contractFields,
        logger: silentLogger,
        progress,
      });
    const committed = await rebuild("rebuild:orderSummary:1");
    await committed.commit({ subscriber: "projection:orderSummary", position: 0 });
    const paused = await rebuild("rebuild:orderSummary:2");
    await paused.pause();
    expect(uses()).toBe(0);
  });

  it("releases a rebuild's connection when its commit fails, and once only when an abort follows", async () => {
    const { adapter, uses } = nodeSqlite();
    const args = {
      name: "orderSummary",
      fields: contractFields,
      logger: silentLogger,
      progress: "rebuild:orderSummary:1",
    };
    const older = await adapter.rebuildReadModel(args);
    const newer = await adapter.rebuildReadModel(args);
    await expect(
      older.commit({ subscriber: "projection:orderSummary", position: 0 }),
    ).rejects.toThrow(RebuildSupersededError);
    expect(uses()).toBe(1);
    await older.abort();
    expect(uses()).toBe(1);
    await newer.abort();
    expect(uses()).toBe(0);
  });

  it("opens the storage and a read model of a database at the latest version with one read each", async () => {
    const db = new DatabaseSync(":memory:");
    const open = { name: "orderSummary", fields: contractFields, logger: silentLogger };
    await nodeSqlite(db).adapter.createStorage();
    await nodeSqlite(db).adapter.createReadModel(open);
    const statements: string[] = [];
    const { adapter } = nodeSqlite(db, "bounda_", statements);
    await adapter.createStorage();
    expect(statements).toEqual([
      'SELECT "scope", max("version") AS "version" FROM "bounda_migrations" GROUP BY "scope"',
    ]);
    statements.length = 0;
    await adapter.createReadModel(open);
    expect(statements.filter((sql) => sql.includes("bounda_migrations"))).toHaveLength(1);
    expect(statements.filter((sql) => /^(CREATE|ALTER|INSERT|UPDATE|DROP)/.test(sql))).toEqual([]);
  });

  it("hands queries the host's raw handle", async () => {
    const { adapter, db } = nodeSqlite();
    const readModel = await adapter.createReadModel({
      name: "orderSummary",
      fields: contractFields,
      logger: silentLogger,
    });
    expect(readModel.client.raw).toBe(db);
  });

  it("prefixes every table and keeps data across adapters on the same database", async () => {
    const db = new DatabaseSync(":memory:");
    const first = await nodeSqlite(db, "app_").adapter.createStorage();
    await first.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1 })],
    });
    const again = nodeSqlite(db, "app_").adapter;
    expect(await (await again.createStorage()).eventStore.lastPosition()).toBe(1);
    await again.createReadModel({
      name: "orderSummary",
      fields: contractFields,
      logger: silentLogger,
    });
    expect(tableNames(db, "app_")).toEqual([
      "app_checkpoints",
      "app_dead_letters",
      "app_events",
      "app_idempotency_keys",
      "app_inbox",
      "app_migrations",
      "app_person_rows",
      "app_personal_keys",
      "app_persons",
      "app_restricted_persons",
      "app_restricted_positions",
      "app_restrictions",
      "app_rm_order_summary",
      "app_scheduled_commands",
      "app_snapshots",
      "app_subscriber_failures",
    ]);
  });

  it("logs the lifecycle of a rebuild and leaves only the live table behind", async () => {
    const { adapter, db } = nodeSqlite();
    const { logs, logger } = recordingLogger();
    const args = { name: "orderSummary", fields: contractFields, logger, progress: "rebuild:1" };
    await (await adapter.rebuildReadModel(args)).commit({
      subscriber: "projection:x",
      position: 0,
    });
    const paused = await adapter.rebuildReadModel(args);
    await paused.transact(({ checkpointStore }) => checkpointStore.set(args.progress, 1));
    await paused.pause();
    const older = await adapter.rebuildReadModel(args);
    const newer = await adapter.rebuildReadModel(args);
    await older.abort();
    await newer.abort();
    const table = "bounda_rm_order_summary";
    const shadow = `${table}__rebuild`;
    expect(logs).toEqual([
      ["read model rebuild started", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild committed", { readModel: "orderSummary", table }],
      ["read model rebuild started", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild paused", { readModel: "orderSummary", table }],
      ["read model rebuild resumed", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild resumed", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild superseded", { readModel: "orderSummary", table }],
      ["read model rebuild aborted", { readModel: "orderSummary", table }],
    ]);
    expect(tableNames(db, "bounda_rm_order")).toEqual([table]);
  });

  it("evolves a read model table additively and refuses destructive changes", async () => {
    const db = new DatabaseSync(":memory:");
    const { logs, logger } = recordingLogger();
    const v1 = { id: f.string().primaryKey(), total: f.number() };
    const first = await nodeSqlite(db).adapter.createReadModel<{ id: string; total: number }>({
      name: "orders",
      fields: v1,
      logger,
    });
    await first.table.insert({ id: "o-1", total: 5 });
    expect(logs).toEqual([]);

    const v2 = { ...v1, note: f.string().optional(), paid: f.boolean().index() };
    const second = await nodeSqlite(db).adapter.createReadModel<{
      id: string;
      total: number;
      note?: string;
      paid: boolean;
    }>({ name: "orders", fields: v2, logger });
    expect(logs).toEqual([
      ["read model table evolved", { readModel: "orders", table: "bounda_rm_orders", added: 3 }],
    ]);
    await nodeSqlite(db).adapter.createReadModel({ name: "orders", fields: v2, logger });
    expect(logs).toHaveLength(1);
    expect(await second.table.findOne({ id: "o-1" })).toEqual({ id: "o-1", total: 5 });
    await second.table.upsert({ id: "o-1", total: 5, paid: true, note: "hi" });
    expect(await second.table.findOne({ id: "o-1" })).toEqual({
      id: "o-1",
      total: 5,
      paid: true,
      note: "hi",
    });

    await expect(
      nodeSqlite(db).adapter.createReadModel({
        name: "orders",
        fields: { id: f.string().primaryKey() },
        logger: silentLogger,
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      nodeSqlite(db).adapter.createReadModel({
        name: "orders",
        fields: { ...v2, total: f.string() },
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Changing a field's type needs a rebuild: run `bounda rebuild orders`/);
  });

  it("refuses a moved primary key, and indexes a field newly unique once", async () => {
    const db = new DatabaseSync(":memory:");
    const { logs, logger } = recordingLogger();
    const open = (fields: FieldsRecord) =>
      nodeSqlite(db).adapter.createReadModel<{ id: string; email: string }>({
        name: "people",
        fields,
        logger,
      });
    const first = await open({ id: f.string().primaryKey(), email: f.string() });
    await first.table.insert({ id: "1", email: "a@example.com" });
    await expect(open({ id: f.string(), email: f.string().primaryKey() })).rejects.toThrow(
      /Moving the primary key needs a rebuild/,
    );
    const unique = { id: f.string().primaryKey(), email: f.string().unique() };
    const second = await open(unique);
    await expect(second.table.insert({ id: "2", email: "a@example.com" })).rejects.toThrow();
    await open(unique);
    expect(logs).toEqual([
      ["read model table evolved", { readModel: "people", table: "bounda_rm_people", added: 1 }],
    ]);
    await expect(open({ id: f.string().primaryKey(), email: f.string() })).rejects.toThrow(
      /Dropping `unique\(\)` needs a rebuild/,
    );
  });

  it("does not take a column of a unique index over several columns for a unique column", async () => {
    const db = new DatabaseSync(":memory:");
    const fields = { id: f.string().primaryKey(), city: f.string(), street: f.string() };
    const open = () =>
      nodeSqlite(db).adapter.createReadModel({ name: "places", fields, logger: silentLogger });
    await open();
    db.exec('CREATE UNIQUE INDEX "places_address" ON "bounda_rm_places" ("city", "street")');
    await expect(open()).resolves.toBeDefined();
  });

  it("reports the stream version when loading past its end", async () => {
    const { eventStore } = await storage();
    await eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [1, 2, 3].map((version) => pendingEvent({ aggregateId: "1", version })),
    });
    expect(
      await eventStore.load({ aggregateType: "order", aggregateId: "1", fromVersion: 5 }),
    ).toEqual({ events: [], version: 3 });
    expect(
      await eventStore.load({ aggregateType: "order", aggregateId: "1", fromVersion: 2 }),
    ).toMatchObject({ version: 3 });
  });

  it("leaves lastError out of a claim that never failed", async () => {
    const { inboxLedger } = await storage();
    const key = { handler: "order.p", eventId: "e-1" };
    await inboxLedger.tryClaim({ ...key, now: new Date(), leaseMs: 1_000 });
    expect(await inboxLedger.get(key)).not.toHaveProperty("lastError");
    await inboxLedger.fail({ ...key, error: "boom" });
    expect(await inboxLedger.get(key)).toMatchObject({ lastError: "boom" });
  });
});

describe("the SQLite forget ledger", () => {
  it("lives in its own prefixed table, created the first time it is used", async () => {
    const { adapter, db } = nodeSqlite(undefined, "app_");
    const ledger = await adapter.createForgetLedger({ tenant: "t-1" });
    expect(tableNames(db, "app_")).toEqual([]);
    await ledger.read({ limit: 1 });
    expect(tableNames(db, "app_")).toEqual([
      "app_forget_ledger",
      "app_forget_ledger_marks",
      "app_migrations",
    ]);
  });
});
