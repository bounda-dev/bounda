import { describe, expect, it } from "vitest";
import { isAdapter } from "../adapter/adapter.ts";
import {
  type ContractRow,
  checkpointStoreContract,
  contractFields,
  deadLetterStoreContract,
  eventStoreContract,
  idempotencyStoreContract,
  inboxLedgerContract,
  pendingEvent,
  personalKeyStoreContract,
  readModelRebuildContract,
  readModelTransactionContract,
  schedulerContract,
  snapshotStoreContract,
  storageTransactionContract,
  tableContract,
  viewContract,
} from "../adapter/testing/index.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import { silentLogger } from "../contracts/logger.ts";
import { fieldBuilder as f } from "../modules/view.ts";
import { createMemoryEventStore } from "./event-store.ts";
import { memory } from "./index.ts";

const storage = async () => memory().createStorage({ logger: silentLogger });

describe("memory adapter", () => {
  eventStoreContract({ create: async () => (await storage()).eventStore });
  checkpointStoreContract({ create: async () => (await storage()).checkpointStore });
  inboxLedgerContract({ create: async () => (await storage()).inboxLedger });
  deadLetterStoreContract({ create: async () => (await storage()).deadLetterStore });
  schedulerContract({ create: async () => (await storage()).scheduler });
  idempotencyStoreContract({ create: storage });
  snapshotStoreContract({ create: storage });
  storageTransactionContract({ create: storage });
  personalKeyStoreContract({ create: async () => (await storage()).personalKeys });
  tableContract({
    create: async () => {
      const model = await memory().createReadModel<ContractRow>({
        name: "order-summary",
        fields: contractFields,
        logger: silentLogger,
      });
      return model.table;
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

  it("appends nothing and notifies nobody when JSON refuses a payload of a later batch", async () => {
    const positions: number[] = [];
    const store = createMemoryEventStore({ onAppend: (position) => positions.push(position) });
    await expect(
      store.appendAll([
        {
          aggregateType: "order",
          aggregateId: "1",
          expectedVersion: 0,
          events: [pendingEvent({ aggregateId: "1", version: 1 })],
        },
        {
          aggregateType: "order",
          aggregateId: "2",
          expectedVersion: 0,
          events: [pendingEvent({ aggregateId: "2", version: 1, payload: { total: 1n } })],
        },
      ]),
    ).rejects.toThrow(TypeError);
    expect(await store.lastPosition()).toBe(0);
    expect((await store.load({ aggregateType: "order", aggregateId: "1" })).version).toBe(0);
    expect(positions).toEqual([]);
  });

  it("says which payload has no JSON", async () => {
    await expect(
      createMemoryEventStore().append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [{ ...pendingEvent({ aggregateId: "1", version: 1 }), payload: undefined }],
      }),
    ).rejects.toMatchObject({ message: "undefined has no JSON to store" });
  });

  it("answers, inside a transaction, the positions its events commit with", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1 })],
    });
    const inside = await storage.transact(async (tx) => {
      const order = await tx.eventStore.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 1,
        events: [2, 3].map((version) =>
          pendingEvent({ aggregateId: "1", version, type: "OrderPaid" }),
        ),
      });
      const payment = await tx.eventStore.append({
        aggregateType: "payment",
        aggregateId: "9",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateType: "payment", aggregateId: "9", version: 1 })],
      });
      expect(await tx.eventStore.lastPosition()).toBe(1);
      return [...order.events, ...payment.events].map((event) => event.position);
    });
    expect(inside).toEqual([2, 3, 4]);
    expect(
      (await storage.eventStore.readAll({ afterPosition: 0, limit: 10 })).map(
        (event) => event.position,
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it("shows an event appended beside a transaction only once the transaction settles, in position order", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const heard: (number | undefined)[] = [];
    await (storage.notifier as NonNullable<typeof storage.notifier>).subscribe((position) => {
      heard.push(position);
    });
    const beside = (version: number) =>
      storage.eventStore.append({
        aggregateType: "order",
        aggregateId: "2",
        expectedVersion: version - 1,
        events: [pendingEvent({ aggregateId: "2", version })],
      });
    const committing = Promise.withResolvers<void>();
    const transaction = storage.transact(async (tx) => {
      await tx.eventStore.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "1", version: 1 })],
      });
      await committing.promise;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect((await beside(1)).events.map((event) => event.position)).toEqual([2]);
    expect(await storage.eventStore.lastPosition()).toBe(0);
    expect(await storage.eventStore.readAll({ afterPosition: 0, limit: 10 })).toEqual([]);
    expect(heard).toEqual([]);
    committing.resolve();
    await transaction;
    expect(await storage.eventStore.lastPosition()).toBe(2);
    expect(
      (await storage.eventStore.readAll({ afterPosition: 0, limit: 10 })).map((event) => [
        event.position,
        event.aggregateId,
      ]),
    ).toEqual([
      [1, "1"],
      [2, "2"],
    ]);
    expect(heard).toEqual([2]);
    expect((await beside(2)).events.map((event) => event.position)).toEqual([3]);
    expect(heard).toEqual([2, 3]);
  });

  it("gives back the positions of a transaction that fails: the tail when nothing came after, a gap readers skip otherwise", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const heard: (number | undefined)[] = [];
    await (storage.notifier as NonNullable<typeof storage.notifier>).subscribe((position) => {
      heard.push(position);
    });
    const failing = (beside?: () => Promise<unknown>) =>
      storage
        .transact(async (tx) => {
          await tx.eventStore.append({
            aggregateType: "order",
            aggregateId: "1",
            expectedVersion: 0,
            events: [pendingEvent({ aggregateId: "1", version: 1 })],
          });
          await beside?.();
          throw new Error("boom");
        })
        .catch(() => undefined);
    await failing();
    expect(
      (
        await storage.eventStore.append({
          aggregateType: "order",
          aggregateId: "2",
          expectedVersion: 0,
          events: [pendingEvent({ aggregateId: "2", version: 1 })],
        })
      ).events.map((event) => event.position),
    ).toEqual([1]);
    expect(heard).toEqual([1]);

    await failing(async () => {
      await storage.eventStore.append({
        aggregateType: "order",
        aggregateId: "3",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "3", version: 1 })],
      });
      expect(await storage.eventStore.lastPosition()).toBe(1);
    });
    expect(await storage.eventStore.lastPosition()).toBe(3);
    expect(heard).toEqual([1, 3]);
    expect(
      (await storage.eventStore.readAll({ afterPosition: 0, limit: 10 })).map((event) => [
        event.position,
        event.aggregateId,
      ]),
    ).toEqual([
      [1, "2"],
      [3, "3"],
    ]);
    expect(await storage.eventStore.readAll({ afterPosition: 1, limit: 1 })).toMatchObject([
      { position: 3 },
    ]);
    expect(
      (
        await storage.eventStore.append({
          aggregateType: "order",
          aggregateId: "4",
          expectedVersion: 0,
          events: [pendingEvent({ aggregateId: "4", version: 1 })],
        })
      ).events.map((event) => event.position),
    ).toEqual([4]);
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
        await tx.idempotencyStore.put({
          key: "lost",
          fingerprint: "fp",
          outcome: { rejected: "Nope", message: "no", aggregateType: "order", aggregateId: "1" },
          expiresAt: "2026-01-02T00:00:00.000Z",
          persons: [],
          now,
        });
        await tx.inboxLedger.fail({ ...key, error: "boom" });
        await tx.inboxLedger.complete(key);
      }),
    ).rejects.toThrow("connection lost");
    expect(await storage.idempotencyStore.get({ key: "lost", now })).toBeNull();
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
    const model = await memory().createReadModel({
      name: "order-summary",
      fields: contractFields,
      logger: silentLogger,
    });
    await expect(model.client.get("SELECT 1")).rejects.toBeInstanceOf(ConfigurationError);
    await expect(model.client.all("SELECT 1")).rejects.toThrow(/table\.findOne/);
    expect(model.client.raw).toBe(model.table);
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

  it("keeps each row in its place through an update, a new key included, as SQLite keeps its rowid", async () => {
    const { table } = await memory().createReadModel<{ id: string; name?: string }>({
      name: "people",
      fields: { id: f.string().primaryKey(), name: f.string().optional() },
      logger: silentLogger,
    });
    for (const id of ["1", "2", "3"]) await table.insert({ id });
    await table.update({ id: "1" }, { name: "Ada" });
    await table.update({ id: "2" }, { id: "0" });
    expect((await table.findMany()).map(({ id }) => id)).toEqual(["1", "0", "3"]);
  });

  it("orders by SQLite's rules: no value first, text by code point", async () => {
    const { table } = await memory().createReadModel<{ id: string; name?: string }>({
      name: "people",
      fields: { id: f.string().primaryKey(), name: f.string().optional() },
      logger: silentLogger,
    });
    for (const [id, name] of [
      ["1", "\u{1F600}"],
      ["2", "！"],
      ["3", undefined],
      ["4", "b"],
    ]) {
      await table.insert(name === undefined ? { id: String(id) } : { id: String(id), name });
    }
    const names = async (direction: "asc" | "desc") =>
      (await table.findMany({ orderBy: { field: "name", direction } })).map(({ id }) => id);
    expect(await names("asc")).toEqual(["3", "4", "2", "1"]);
    expect(await names("desc")).toEqual(["1", "2", "4", "3"]);
  });

  it("names the constraint a write breaks, as SQLite does", async () => {
    const { table } = await memory().createReadModel<{ id: string; email: string }>({
      name: "people",
      fields: { id: f.string().primaryKey(), email: f.string().unique() },
      logger: silentLogger,
    });
    await table.insert({ id: "1", email: "ada@example.com" });
    await table.insert({ id: "2", email: "grace@example.com" });
    await expect(table.insert({ id: "3", email: "ada@example.com" })).rejects.toMatchObject({
      message: "UNIQUE constraint failed: people.email",
    });
    await expect(table.insert({ id: "3" } as never)).rejects.toMatchObject({
      message: "NOT NULL constraint failed: people.email",
    });
    await expect(table.update({ id: "1" }, { id: "2" })).rejects.toMatchObject({
      message: "UNIQUE constraint failed: people.id",
    });
  });

  it("orders numbers by value, below none when descending", async () => {
    const { table } = await memory().createReadModel<{ id: string; total?: number }>({
      name: "totals",
      fields: { id: f.string().primaryKey(), total: f.number().optional() },
      logger: silentLogger,
    });
    for (const [id, total] of [
      ["1", 5],
      ["2", -3],
      ["3", undefined],
      ["4", 0],
    ] as const) {
      await table.insert(total === undefined ? { id } : { id, total });
    }
    const ids = async (direction: "asc" | "desc") =>
      (await table.findMany({ orderBy: { field: "total", direction } })).map(({ id }) => id);
    expect(await ids("asc")).toEqual(["3", "2", "4", "1"]);
    expect(await ids("desc")).toEqual(["1", "4", "2", "3"]);
  });
});
