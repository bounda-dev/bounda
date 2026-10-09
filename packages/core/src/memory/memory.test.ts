import { describe, expect, it } from "vitest";
import { isAdapter } from "../adapter/adapter.ts";
import {
  type ContractRow,
  checkpointStoreContract,
  contractFields,
  deadLetterStoreContract,
  eventStoreContract,
  inboxLedgerContract,
  pendingEvent,
  readModelRebuildContract,
  readModelTransactionContract,
  schedulerContract,
  storageTransactionContract,
  tableContract,
  viewContract,
} from "../adapter/testing/index.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import { silentLogger } from "../contracts/logger.ts";
import { fieldBuilder as f } from "../modules/view.ts";
import { createMemoryEventStore, memory } from "./index.ts";

const storage = async () => memory().createStorage({ logger: silentLogger });

describe("memory adapter", () => {
  eventStoreContract({ create: async () => (await storage()).eventStore });
  checkpointStoreContract({ create: async () => (await storage()).checkpointStore });
  inboxLedgerContract({ create: async () => (await storage()).inboxLedger });
  deadLetterStoreContract({ create: async () => (await storage()).deadLetterStore });
  schedulerContract({ create: async () => (await storage()).scheduler });
  storageTransactionContract({ create: storage });
  tableContract({
    create: async () => {
      const ports = await memory().createReadModel<ContractRow>({
        name: "order-summary",
        fields: contractFields,
        logger: silentLogger,
      });
      return ports.table;
    },
  });
  viewContract({ create: async () => memory() });
  it("appends several batches in order, a stream's later batch on its earlier one, and notifies once", async () => {
    const positions: number[] = [];
    const store = createMemoryEventStore({ onAppend: (position) => positions.push(position) });
    const order = { aggregateType: "order", aggregateId: "1" };
    const results = await store.appendAll([
      { ...order, expectedVersion: 0, events: [pendingEvent({ aggregateId: "1", version: 1 })] },
      { ...order, expectedVersion: 1, events: [] },
      {
        ...order,
        expectedVersion: 1,
        events: [pendingEvent({ aggregateId: "1", version: 2, type: "OrderPaid" })],
      },
    ]);
    expect(results.map((result) => result.version)).toEqual([1, 1, 2]);
    expect((await store.load(order)).events.map((event) => event.position)).toEqual([1, 2]);
    expect(positions).toEqual([2]);

    await expect(
      store.appendAll([
        {
          ...order,
          expectedVersion: 2,
          events: [pendingEvent({ aggregateId: "1", version: 3, type: "OrderArchived" })],
        },
        { ...order, expectedVersion: 2, events: [pendingEvent({ aggregateId: "1", version: 3 })] },
      ]),
    ).rejects.toMatchObject({ streamId: "order:1", expectedVersion: 2, actualVersion: 3 });
    expect((await store.load(order)).version).toBe(2);
    expect(positions).toEqual([2]);
  });

  it("puts every store back when a write fails while a transaction is being applied", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const key = { handler: "order.p", eventId: "e1" };
    const now = new Date("2026-01-01T00:00:00.000Z");
    const context = { correlationId: "c", causationId: "c", depth: 0 };
    const letter = (id: string) => ({
      id,
      kind: "policy" as const,
      handler: "order.p",
      eventId: "e1",
      eventType: "OrderPlaced",
      aggregateType: "order",
      aggregateId: "1",
      errorType: "terminal" as const,
      errorMessage: "boom",
      attempts: 1,
      firstFailedAt: now.toISOString(),
      lastFailedAt: now.toISOString(),
    });
    // What was there before must survive the restore as it was.
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1 })],
    });
    await storage.scheduler.schedule({
      dedupeKey: "command:kept",
      command: { type: "Remind", aggregateId: "1", payload: {} },
      executeAt: now,
      context,
    });
    await storage.deadLetterStore.add(letter("kept"));
    await storage.inboxLedger.tryClaim({ ...key, now, leaseMs: 1_000 });
    storage.inboxLedger.complete = async () => {
      throw new Error("connection lost");
    };
    await expect(
      storage.transact(async (tx) => {
        await tx.eventStore.append({
          aggregateType: "order",
          aggregateId: "1",
          expectedVersion: 1,
          events: [pendingEvent({ aggregateId: "1", version: 2, type: "OrderPaid" })],
        });
        await tx.eventStore.append({
          aggregateType: "payment",
          aggregateId: "9",
          expectedVersion: 0,
          events: [
            pendingEvent({
              aggregateType: "payment",
              aggregateId: "9",
              version: 1,
              type: "PaymentRequested",
            }),
          ],
        });
        await tx.scheduler.schedule({
          dedupeKey: "command:lost",
          command: { type: "Remind", aggregateId: "1", payload: {} },
          executeAt: now,
          context,
        });
        await tx.deadLetterStore.add(letter("lost"));
        await tx.inboxLedger.fail({ ...key, error: "boom" });
        await tx.inboxLedger.complete(key);
      }),
    ).rejects.toThrow("connection lost");
    expect(await storage.eventStore.lastPosition()).toBe(1);
    expect(
      (await storage.eventStore.load({ aggregateType: "order", aggregateId: "1" })).events.map(
        (event) => event.type,
      ),
    ).toEqual(["OrderPlaced"]);
    expect(await storage.eventStore.load({ aggregateType: "payment", aggregateId: "9" })).toEqual({
      events: [],
      version: 0,
    });
    expect((await storage.scheduler.list()).map((entry) => entry.dedupeKey)).toEqual([
      "command:kept",
    ]);
    expect((await storage.deadLetterStore.list()).map((entry) => entry.id)).toEqual(["kept"]);
    expect(await storage.inboxLedger.get(key)).toMatchObject({ status: "pending", attempts: 1 });
  });
  readModelRebuildContract({ create: async () => memory() });
  readModelTransactionContract({ create: async () => memory(), locking: "per-subscriber" });

  it("is a full adapter with one storage per instance, isolated from other instances", async () => {
    const adapter = memory();
    expect(isAdapter(adapter)).toBe(true);
    expect(adapter).toMatchObject({ kind: "bounda-adapter", name: "memory", options: {} });
    const first = await adapter.createStorage({ logger: silentLogger });
    const again = await adapter.createStorage({ logger: silentLogger });
    const second = await memory().createStorage({ logger: silentLogger });
    await first.checkpointStore.set("policies", 4);
    expect(await again.checkpointStore.get("policies")).toBe(4);
    expect(await second.checkpointStore.get("policies")).toBe(0);
    await first.close();
  });

  it("notifies every subscriber of an append with the last position, until they unsubscribe", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const heard: (number | undefined)[] = [];
    const stop = await (storage.notifier as NonNullable<typeof storage.notifier>).subscribe(
      (position) => {
        heard.push(position);
      },
    );
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [1, 2].map((version) => pendingEvent({ aggregateId: "1", version })),
    });
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 2,
      events: [],
    });
    expect(heard).toEqual([2]);
    await stop();
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "2",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "2", version: 1 })],
    });
    expect(heard).toEqual([2]);
  });

  it("works as a bare event store, with nobody to notify", async () => {
    const store = createMemoryEventStore();
    await store.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1 })],
    });
    expect(await store.lastPosition()).toBe(1);
  });

  it("opens the same read model twice on the same rows", async () => {
    const adapter = memory();
    const first = await adapter.createReadModel<ContractRow>({
      name: "order-summary",
      fields: contractFields,
      logger: silentLogger,
    });
    const second = await adapter.createReadModel<ContractRow>({
      name: "order-summary",
      fields: contractFields,
      logger: silentLogger,
    });
    await first.table.insert({ orderId: "1", customerId: "c", status: "placed", total: 1 });
    expect(await second.table.count()).toBe(1);
  });

  it("refuses SQL through its read client and points at table instead", async () => {
    const ports = await memory().createReadModel({
      name: "order-summary",
      fields: contractFields,
      logger: silentLogger,
    });
    await expect(ports.client.get("SELECT 1")).rejects.toBeInstanceOf(ConfigurationError);
    await expect(ports.client.all("SELECT 1")).rejects.toThrow(/table\.findOne/);
    expect(ports.client.raw).toBe(ports.table);
  });

  it("requires a primary key in the view", async () => {
    await expect(
      memory().createReadModel({
        name: "no-key",
        fields: { total: f.number() },
        logger: silentLogger,
      }),
    ).rejects.toThrow('Read model "no-key" declares no primary key field');
  });
});
