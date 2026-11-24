import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../contracts/logger.ts";
import { type FieldsRecord, fieldBuilder as f } from "../../modules/view.ts";
import type { Adapter, ReadModelStorage, Storage } from "../adapter.ts";
import type { TenantFence } from "../storage/tenant-fence.ts";
import { pendingEvent, testCommand, testContext, testDeadLetter } from "./fixtures.ts";

export interface TenantFenceContractArgs {
  /**
   * An adapter over a fresh, empty database.
   */
  readonly create: () => Promise<Adapter>;
  /**
   * Whether a write can be held open while the fence is raised from the same test, as it cannot
   * inside a Durable Object.
   */
  readonly concurrent?: boolean;
}

export interface TenantFenceContractFunction {
  (args: TenantFenceContractArgs): void;
}

const AT = "2026-03-01T00:00:00.000Z";
const FROZEN: TenantFence = { state: "frozen", tenant: "acme", since: AT };
const FORGOTTEN: TenantFence = { state: "forgotten", tenant: "acme", since: AT };
const at = (seconds: number): Date => new Date(Date.parse(AT) + seconds * 1_000);

const disclosure = {
  person: "c-1",
  port: "customer.mailer",
  recipient: "Mailchimp",
  kind: "processor",
  country: "US",
  safeguard: null,
  category: "contact",
};

const fields: FieldsRecord = { orderId: f.string().primaryKey(), total: f.number() };

// One of every kind of write each store takes, outside a transaction and inside one.
const writesOf = (storage: Storage): readonly (readonly [string, () => Promise<unknown>])[] => [
  [
    "eventStore.append",
    () =>
      storage.eventStore.append({
        aggregateType: "order",
        aggregateId: "o-2",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "o-2", version: 1 })],
      }),
  ],
  [
    "transact",
    () =>
      storage.transact((transaction) =>
        transaction.eventStore.append({
          aggregateType: "order",
          aggregateId: "o-3",
          expectedVersion: 0,
          events: [pendingEvent({ aggregateId: "o-3", version: 1 })],
        }),
      ),
  ],
  ["checkpointStore.set", () => storage.checkpointStore.set("projection:x", 9)],
  ["checkpointStore.compareAndSet", () => storage.checkpointStore.compareAndSet("p", 0, 1)],
  ["checkpointStore.remove", () => storage.checkpointStore.remove("projection:x")],
  [
    "inboxLedger.tryClaim",
    () =>
      storage.inboxLedger.tryClaim({ handler: "h", eventId: "e-9", now: at(1), leaseMs: 60_000 }),
  ],
  ["deadLetterStore.add", () => storage.deadLetterStore.add(testDeadLetter("l-2"))],
  [
    "deadLetterStore.updateStatus",
    () => storage.deadLetterStore.updateStatus("l-1", "discarded", at(1)),
  ],
  ["deadLetterStore.remove", () => storage.deadLetterStore.remove("l-1")],
  ["deadLetterStore.clear", () => storage.deadLetterStore.clear()],
  [
    "scheduler.schedule",
    () =>
      storage.scheduler.schedule({
        dedupeKey: "k-2",
        command: testCommand("2"),
        executeAt: at(1),
        scheduledAt: at(1),
        context: testContext,
      }),
  ],
  ["scheduler.cancel", () => storage.scheduler.cancel("k-1")],
  [
    "scheduler.claimDue",
    () => storage.scheduler.claimDue({ now: at(5), limit: 10, leaseMs: 60_000 }),
  ],
  ["idempotencyStore.purge", () => storage.idempotencyStore.purge({ now: at(1_000_000) })],
  ["idempotencyStore.clear", () => storage.idempotencyStore.clear()],
  ["personalKeys.touch", () => storage.personalKeys.touch("c-1", AT)],
  ["personalKeys.clear", () => storage.personalKeys.clear()],
  [
    "persons.record",
    () =>
      storage.persons.record({ person: "c-1", position: 9, lastActiveAt: AT, forgottenAt: null }),
  ],
  [
    "persons.restrict",
    () =>
      storage.persons.restrict("c-1", {
        ground: "accuracy-contested",
        categories: null,
        since: at(0),
      }),
  ],
  ["recipients.disclose", () => storage.recipients.disclose([disclosure], AT)],
  [
    "recipients.declare",
    () => storage.recipients.declare([{ port: "customer.crm", categories: ["contact"] }], 1, AT),
  ],
  [
    "snapshotStore.put",
    () =>
      storage.snapshotStore.put({
        aggregateType: "order",
        aggregateId: "o-1",
        version: 1,
        fingerprint: "f-1",
        state: "{}",
        persons: [],
      }),
  ],
  ["snapshotStore.clear", () => storage.snapshotStore.clear()],
  ["subscriberFailures.clear", () => storage.subscriberFailures.clear()],
  ["indexKeys.clear", () => storage.indexKeys.clear()],
];

// What the stores answer while the tenant takes no write: every read goes on.
const readsOf = (storage: Storage): readonly (() => Promise<unknown>)[] => [
  () => storage.eventStore.readAll({ afterPosition: 0, limit: 10 }),
  () => storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" }),
  () => storage.eventStore.lastPosition(),
  () => storage.checkpointStore.list(),
  () => storage.deadLetterStore.list({}),
  () => storage.scheduler.list(),
  () => storage.idempotencyStore.listByPerson({ person: "c-1", now: at(1) }),
  () => storage.personalKeys.categories(),
  () => storage.persons.restrictions("c-1"),
  () => storage.recipients.disclosures("c-1"),
  () => storage.subscriberFailures.list(),
  () => storage.indexKeys.get(),
  () => storage.tenancy.get(),
];

const seed = async (storage: Storage): Promise<void> => {
  await storage.eventStore.append({
    aggregateType: "order",
    aggregateId: "o-1",
    expectedVersion: 0,
    events: [pendingEvent({ aggregateId: "o-1", version: 1 })],
  });
  await storage.checkpointStore.set("projection:x", 1);
  await storage.deadLetterStore.add(testDeadLetter("l-1"));
  await storage.scheduler.schedule({
    dedupeKey: "k-1",
    command: testCommand("1"),
    executeAt: at(1),
    scheduledAt: at(1),
    context: testContext,
  });
  await storage.persons.record({ person: "c-1", position: 1, lastActiveAt: AT, forgottenAt: null });
  await storage.recipients.disclose([disclosure], AT);
};

const stateOf = async (storage: Storage) => ({
  events: await storage.eventStore.readAll({ afterPosition: 0, limit: 10 }),
  checkpoints: await storage.checkpointStore.list(),
  letters: (await storage.deadLetterStore.list({})).map(({ id, status }) => [id, status]),
  scheduled: (await storage.scheduler.list()).map(({ dedupeKey, attempts }) => [
    dedupeKey,
    attempts,
  ]),
  person: await storage.persons.get("c-1"),
  disclosures: await storage.recipients.disclosures("c-1"),
  declared: await storage.recipients.declared(),
});

/**
 * What every adapter does with the fence of its database: once it is raised, no write of the
 * tenant lands through any storage or read model opened over the database, the one that raised it
 * or another, inside a transaction or outside one, and nothing of the refused write is kept; reads
 * go on. `forgotten` is final, and only the storage `forgotten()` hands out writes through it.
 */
export const tenantFenceContract: TenantFenceContractFunction = ({ create, concurrent = true }) => {
  describe("tenant fence contract", () => {
    const closes: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const close of closes.splice(0).reverse()) await close();
    });
    const storageOf = async (adapter: Adapter): Promise<Storage> => {
      const storage = await adapter.createStorage();
      closes.push(() => storage.close());
      return storage;
    };
    const readModelOf = async (adapter: Adapter): Promise<ReadModelStorage> => {
      const readModel = await adapter.createReadModel<Record<string, unknown>>({
        name: "orderTotals",
        fields,
        logger: silentLogger,
      });
      closes.push(() => readModel.close());
      return readModel;
    };

    it("reads open on a database never fenced", async () => {
      const storage = await storageOf(await create());
      expect(await storage.fence.read()).toEqual({ state: "open" });
    });

    it("refuses every write of every store once frozen, on every storage over the database, keeping nothing of it", async () => {
      const adapter = await create();
      const storage = await storageOf(adapter);
      await seed(storage);
      const before = await stateOf(storage);
      expect(await storage.fence.set(FROZEN)).toEqual(FROZEN);
      // Another instance, which never read the fence.
      const other = await storageOf(adapter);
      for (const writer of [storage, other, storage.forgotten()]) {
        for (const [name, write] of writesOf(writer)) {
          await expect(write(), name).rejects.toMatchObject({
            code: "TENANT_FROZEN",
            tenant: "acme",
            frozenAt: AT,
          });
        }
        for (const read of readsOf(writer)) await read();
      }
      expect(await stateOf(other)).toEqual(before);
      expect(await other.fence.read()).toEqual(FROZEN);
    });

    it("keeps the first time it was frozen, and takes every write again once open", async () => {
      const adapter = await create();
      const storage = await storageOf(adapter);
      await seed(storage);
      await storage.fence.set(FROZEN);
      expect(await storage.fence.set({ ...FROZEN, since: at(60).toISOString() })).toEqual(FROZEN);
      expect(await storage.fence.set({ state: "open" })).toEqual({ state: "open" });
      const other = await storageOf(adapter);
      expect(await other.fence.read()).toEqual({ state: "open" });
      for (const [, write] of writesOf(other)) await write();
    });

    it("stays forgotten for good, frozen or not before, and takes the writes of `forgotten()` alone", async () => {
      const adapter = await create();
      const storage = await storageOf(adapter);
      await seed(storage);
      await storage.fence.set(FROZEN);
      expect(await storage.fence.set(FORGOTTEN)).toEqual(FORGOTTEN);
      expect(await storage.fence.set({ state: "open" })).toEqual(FORGOTTEN);
      expect(await storage.fence.set(FROZEN)).toEqual(FORGOTTEN);
      const other = await storageOf(adapter);
      for (const [name, write] of writesOf(other)) {
        await expect(write(), name).rejects.toMatchObject({
          code: "TENANT_FORGOTTEN",
          tenant: "acme",
          forgottenAt: AT,
        });
      }
      const forgotten = other.forgotten();
      await forgotten.checkpointStore.set("recipients", 4);
      await forgotten.transact((transaction) =>
        transaction.eventStore.append({
          aggregateType: "bounda",
          aggregateId: "acme",
          expectedVersion: 0,
          events: [pendingEvent({ aggregateType: "bounda", aggregateId: "acme", version: 1 })],
        }),
      );
      await forgotten.deadLetterStore.clear();
      expect(await other.checkpointStore.get("recipients")).toBe(4);
      expect(await other.eventStore.lastPosition()).toBe(2);
    });

    it("refuses the writes of a read model once its database is frozen, and those of a rebuild", async () => {
      const adapter = await create();
      const readModel = await readModelOf(adapter);
      await readModel.table.upsert({ orderId: "o-1", total: 1 });
      await readModel.checkpointStore.set("projection:orderTotals", 1);
      expect(await readModel.fence.set(FROZEN)).toEqual(FROZEN);
      const other = await readModelOf(adapter);
      for (const target of [readModel, other]) {
        await expect(target.table.upsert({ orderId: "o-2", total: 2 })).rejects.toMatchObject({
          code: "TENANT_FROZEN",
        });
        await expect(target.table.delete({})).rejects.toMatchObject({ code: "TENANT_FROZEN" });
        await expect(target.checkpointStore.set("projection:orderTotals", 2)).rejects.toMatchObject(
          { code: "TENANT_FROZEN" },
        );
        await expect(
          target.transact({
            subscriber: "projection:orderTotals",
            wait: true,
            work: ({ table }) => table.upsert({ orderId: "o-3", total: 3 }),
          }),
        ).rejects.toMatchObject({ code: "TENANT_FROZEN" });
        // A forgetting's own write is refused too while the database is only frozen.
        await expect(
          target.transact({
            subscriber: "projection:orderTotals",
            wait: true,
            forgotten: true,
            work: ({ table }) => table.delete({}),
          }),
        ).rejects.toMatchObject({ code: "TENANT_FROZEN" });
      }
      await expect(
        adapter.rebuildReadModel({
          name: "orderTotals",
          fields,
          logger: silentLogger,
          progress: "rebuild:orderTotals",
        }),
      ).rejects.toMatchObject({ code: "TENANT_FROZEN" });
      expect(await other.table.findMany()).toEqual([{ orderId: "o-1", total: 1 }]);
      expect(await other.checkpointStore.get("projection:orderTotals")).toBe(1);
      await other.fence.set(FORGOTTEN);
      await expect(
        other.transact({
          subscriber: "projection:orderTotals",
          wait: true,
          work: ({ table }) => table.upsert({ orderId: "o-3", total: 3 }),
        }),
      ).rejects.toMatchObject({ code: "TENANT_FORGOTTEN" });
      await other.transact({
        subscriber: "projection:orderTotals",
        wait: true,
        forgotten: true,
        work: ({ table }) => table.delete({}),
      });
      expect(await readModel.table.findMany()).toEqual([]);
    });

    it.skipIf(!concurrent)(
      "raises the fence once a write under way committed, which then lands before it",
      async () => {
        const adapter = await create();
        const storage = await storageOf(adapter);
        const other = await storageOf(adapter);
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let began: () => void = () => undefined;
        const beginning = new Promise<void>((resolve) => {
          began = resolve;
        });
        const writing = storage.transact(async (transaction) => {
          began();
          await held;
          return transaction.eventStore.append({
            aggregateType: "order",
            aggregateId: "o-1",
            expectedVersion: 0,
            events: [pendingEvent({ aggregateId: "o-1", version: 1 })],
          });
        });
        await beginning;
        let raised = false;
        const raising = other.fence.set(FROZEN).then((fence) => {
          raised = true;
          return fence;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(raised).toBe(false);
        release();
        await writing;
        expect(await raising).toEqual(FROZEN);
        expect(await other.eventStore.lastPosition()).toBe(1);
        await expect(
          storage.eventStore.append({
            aggregateType: "order",
            aggregateId: "o-1",
            expectedVersion: 1,
            events: [pendingEvent({ aggregateId: "o-1", version: 2 })],
          }),
        ).rejects.toMatchObject({ code: "TENANT_FROZEN" });
      },
    );
  });
};
