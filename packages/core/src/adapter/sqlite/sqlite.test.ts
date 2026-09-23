/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import type { SqlDatabase } from "../sql/database.ts";
import type { SqlExecutor } from "../sql/sql-table.ts";
import {
  type ContractRow,
  checkpointStoreContract,
  contractFields,
  deadLetterStoreContract,
  eventStoreContract,
  inboxLedgerContract,
  pendingEvent,
  readModelRebuildContract,
  schedulerContract,
  tableContract,
} from "../testing/index.ts";
import { createSqliteAdapter, storageSchemaAdditions, storageTablesFor } from "./index.ts";

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
          const result = await work(executor);
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
  readModelRebuildContract({ create: async () => nodeSqlite().adapter });
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
    });
    expect(uses()).toBe(3);
    await rebuild.abort();
    await readModel.close();
    await opened.close();
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
      "app_order_summary",
      "app_scheduled_commands",
    ]);
  });

  it("adds the columns a database created by an earlier version lacks", async () => {
    const db = new DatabaseSync(":memory:");
    await nodeSqlite(db).adapter.createStorage({ logger: silentLogger });
    db.exec('ALTER TABLE "bounda_dead_letters" DROP COLUMN "payload"');
    const opened = await nodeSqlite(db).adapter.createStorage({ logger: silentLogger });
    const letter = await opened.deadLetterStore.add({
      id: "cmd",
      kind: "command",
      subscriber: "scheduled:PlaceOrder",
      eventId: "k",
      eventType: "PlaceOrder",
      aggregateType: "order",
      aggregateId: "o-1",
      errorType: "terminal",
      errorMessage: "nope",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
      payload: { orderId: "o-1" },
    });
    expect(letter.payload).toEqual({ orderId: "o-1" });
    expect(
      storageSchemaAdditions({ tables: storageTablesFor("x_"), deadLetterColumns: ["id"] }),
    ).toEqual(['ALTER TABLE "x_dead_letters" ADD COLUMN "payload" TEXT']);
    expect(
      storageSchemaAdditions({
        tables: storageTablesFor("x_"),
        deadLetterColumns: ["id", "payload"],
      }),
    ).toEqual([]);
  });

  it("logs the lifecycle of a rebuild and leaves only the live table behind", async () => {
    const { adapter, db } = nodeSqlite();
    const { logs, logger } = recordingLogger();
    const args = { name: "orderSummary", fields: contractFields, logger };
    await (await adapter.rebuildReadModel(args)).commit();
    await (await adapter.rebuildReadModel(args)).pause();
    await (await adapter.rebuildReadModel({ ...args, resume: true })).abort();
    const table = "bounda_order_summary";
    const shadow = `${table}__rebuild`;
    expect(logs).toEqual([
      ["read model rebuild started", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild committed", { readModel: "orderSummary", table }],
      ["read model rebuild started", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild paused", { readModel: "orderSummary", table }],
      ["read model rebuild resumed", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild aborted", { readModel: "orderSummary", table }],
    ]);
    expect(tableNames(db, "bounda_order")).toEqual([table]);
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
      ["read model table evolved", { readModel: "orders", table: "bounda_orders", added: 3 }],
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
    const key = { subscriber: "policies", eventId: "e-1" };
    await inboxLedger.tryClaim({ ...key, now: new Date(), leaseMs: 1_000 });
    expect(await inboxLedger.get(key)).not.toHaveProperty("lastError");
    await inboxLedger.fail({ ...key, error: "boom" });
    expect(await inboxLedger.get(key)).toMatchObject({ lastError: "boom" });
  });
});
