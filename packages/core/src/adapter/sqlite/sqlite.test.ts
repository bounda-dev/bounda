/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConfigurationError, RebuildSupersededError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { type FieldsRecord, fieldBuilder as f } from "../../modules/view.ts";
import type { SqlDatabase } from "../sql/database.ts";
import type { SqlExecutor } from "../sql/sql-table.ts";
import {
  type ContractRow,
  checkpointStoreContract,
  contractFields,
  deadLetterStoreContract,
  eventStoreContract,
  inboxLedgerContract,
  type JsonRow,
  jsonFields,
  jsonValuesContract,
  pendingEvent,
  readModelRebuildContract,
  readModelTransactionContract,
  schedulerContract,
  storageTransactionContract,
  tableContract,
} from "../testing/index.ts";
import { createSqliteAdapter } from "./index.ts";

const bind = (params: readonly unknown[]): SQLInputValue[] =>
  params.map((value) => (typeof value === "boolean" ? Number(value) : value)) as SQLInputValue[];

const nodeSqlite = (db = new DatabaseSync(":memory:"), tablePrefix = "bounda_") => {
  const executor: SqlExecutor = {
    run: async (sql, params) => {
      db.prepare(sql).run(...bind(params));
    },
    all: async (sql, params) => db.prepare(sql).all(...bind(params)) as Record<string, unknown>[],
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

const storage = () => nodeSqlite().adapter.createStorage({ logger: silentLogger });

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
  eventStoreContract({ create: async () => (await storage()).eventStore });
  checkpointStoreContract({ create: async () => (await storage()).checkpointStore });
  inboxLedgerContract({ create: async () => (await storage()).inboxLedger });
  deadLetterStoreContract({ create: async () => (await storage()).deadLetterStore });
  schedulerContract({ create: async () => (await storage()).scheduler });
  storageTransactionContract({ create: storage });
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
  jsonValuesContract({
    create: async () =>
      (
        await nodeSqlite().adapter.createReadModel<JsonRow>({
          name: "documents",
          fields: jsonFields,
          logger: silentLogger,
        })
      ).table,
  });
  readModelRebuildContract({ create: async () => nodeSqlite().adapter });
  readModelTransactionContract({
    create: async () => nodeSqlite().adapter,
    locking: "single-writer",
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
    const opened = await adapter.createStorage({ logger: silentLogger });
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
    await expect(adapter.createStorage({ logger: silentLogger })).rejects.toThrow(/not open/);
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
    const first = await nodeSqlite(db, "app_").adapter.createStorage({ logger: silentLogger });
    await first.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1 })],
    });
    const again = nodeSqlite(db, "app_").adapter;
    expect(
      await (await again.createStorage({ logger: silentLogger })).eventStore.lastPosition(),
    ).toBe(1);
    await again.createReadModel({
      name: "orderSummary",
      fields: contractFields,
      logger: silentLogger,
    });
    expect(tableNames(db, "app_")).toEqual([
      "app_checkpoints",
      "app_dead_letters",
      "app_events",
      "app_inbox",
      "app_rm_order_summary",
      "app_scheduled_commands",
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
