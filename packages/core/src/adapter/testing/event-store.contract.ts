import { beforeEach, describe, expect, it } from "vitest";
import { ConcurrencyError } from "../../contracts/errors.ts";
import type { EventStore } from "../ports/event-store.ts";
import { pendingEvent } from "./fixtures.ts";

export interface EventStoreContractArgs {
  readonly create: () => Promise<EventStore>;
}

export interface EventStoreContractFunction {
  (args: EventStoreContractArgs): void;
}

/**
 * The behaviour every event store must exhibit. Call it inside a `describe` of the adapter's
 * test file with a factory that returns a fresh, empty store.
 */
export const eventStoreContract: EventStoreContractFunction = ({ create }) => {
  describe("event store contract", () => {
    let store: EventStore;

    beforeEach(async () => {
      store = await create();
    });

    it("appends to a new stream and assigns increasing positions", async () => {
      const result = await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [
          pendingEvent({ aggregateId: "1", version: 1 }),
          pendingEvent({ aggregateId: "1", version: 2, type: "OrderPaid" }),
        ],
      });
      expect(result.version).toBe(2);
      expect(result.events.map((event) => event.position)).toEqual([1, 2]);
      expect(result.events[1]?.type).toBe("OrderPaid");
      expect(await store.lastPosition()).toBe(2);
    });

    it("loads a stream with its version and preserves every field", async () => {
      await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "1", version: 1, payload: { total: 42 } })],
      });
      const loaded = await store.load({ aggregateType: "order", aggregateId: "1" });
      expect(loaded.version).toBe(1);
      expect(loaded.events).toHaveLength(1);
      expect(loaded.events[0]).toMatchObject({
        id: "order-1-1",
        aggregateType: "order",
        aggregateId: "1",
        version: 1,
        position: 1,
        type: "OrderPlaced",
        payload: { total: 42 },
        timestamp: "2026-01-01T00:00:00.000Z",
        metadata: {
          correlationId: "corr-1",
          causationId: "cmd-1",
          depth: 0,
          schemaVersion: 1,
          system: false,
        },
      });
    });

    it("returns an empty stream at version 0 for an unknown aggregate", async () => {
      const loaded = await store.load({ aggregateType: "order", aggregateId: "missing" });
      expect(loaded).toEqual({ events: [], version: 0 });
    });

    it("loads from a version onwards", async () => {
      await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [1, 2, 3].map((version) => pendingEvent({ aggregateId: "1", version })),
      });
      const loaded = await store.load({ aggregateType: "order", aggregateId: "1", fromVersion: 3 });
      expect(loaded.events.map((event) => event.version)).toEqual([3]);
      expect(loaded.version).toBe(3);
    });

    it("keeps streams apart even when ids repeat across aggregate types", async () => {
      await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "1", version: 1 })],
      });
      await store.append({
        aggregateType: "customer",
        aggregateId: "1",
        expectedVersion: 0,
        events: [
          pendingEvent({
            aggregateType: "customer",
            aggregateId: "1",
            version: 1,
            type: "CustomerRegistered",
          }),
        ],
      });
      const order = await store.load({ aggregateType: "order", aggregateId: "1" });
      const customer = await store.load({ aggregateType: "customer", aggregateId: "1" });
      expect(order.events.map((event) => event.type)).toEqual(["OrderPlaced"]);
      expect(customer.events.map((event) => event.type)).toEqual(["CustomerRegistered"]);
    });

    it("rejects an append whose expected version is stale", async () => {
      await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "1", version: 1 })],
      });
      let error: unknown;
      try {
        await store.append({
          aggregateType: "order",
          aggregateId: "1",
          expectedVersion: 0,
          events: [pendingEvent({ aggregateId: "1", version: 1, id: "dup" })],
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConcurrencyError);
      expect(error).toMatchObject({ streamId: "order:1", expectedVersion: 0, actualVersion: 1 });
      const loaded = await store.load({ aggregateType: "order", aggregateId: "1" });
      expect(loaded.version).toBe(1);
      expect(await store.lastPosition()).toBe(1);
    });

    it("lets exactly one of two concurrent writers win", async () => {
      const results = await Promise.allSettled([
        store.append({
          aggregateType: "order",
          aggregateId: "1",
          expectedVersion: 0,
          events: [pendingEvent({ aggregateId: "1", version: 1, id: "a" })],
        }),
        store.append({
          aggregateType: "order",
          aggregateId: "1",
          expectedVersion: 0,
          events: [pendingEvent({ aggregateId: "1", version: 1, id: "b" })],
        }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyError);
      const loaded = await store.load({ aggregateType: "order", aggregateId: "1" });
      expect(loaded.events).toHaveLength(1);
    });

    it("reads the global stream in position order across aggregates, honouring limit", async () => {
      await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "1", version: 1 })],
      });
      await store.append({
        aggregateType: "order",
        aggregateId: "2",
        expectedVersion: 0,
        events: [
          pendingEvent({ aggregateId: "2", version: 1 }),
          pendingEvent({ aggregateId: "2", version: 2 }),
        ],
      });
      await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 1,
        events: [pendingEvent({ aggregateId: "1", version: 2 })],
      });
      const all = await store.readAll({ afterPosition: 0, limit: 10 });
      expect(all.map((event) => [event.aggregateId, event.version, event.position])).toEqual([
        ["1", 1, 1],
        ["2", 1, 2],
        ["2", 2, 3],
        ["1", 2, 4],
      ]);
      const page = await store.readAll({ afterPosition: 1, limit: 2 });
      expect(page.map((event) => event.position)).toEqual([2, 3]);
      expect(await store.readAll({ afterPosition: 4, limit: 10 })).toEqual([]);
      expect(await store.lastPosition()).toBe(4);
    });

    it("starts the global stream at position 0", async () => {
      expect(await store.lastPosition()).toBe(0);
      expect(await store.readAll({ afterPosition: 0, limit: 10 })).toEqual([]);
    });
  });
};
