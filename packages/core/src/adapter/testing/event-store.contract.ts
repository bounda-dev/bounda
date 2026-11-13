import { beforeEach, describe, expect, it } from "vitest";
import { ConcurrencyError, ProcessingRestrictedError } from "../../contracts/errors.ts";
import type { Storage } from "../adapter.ts";
import { ForgottenSinceLoadError } from "../storage/append-checks.ts";
import type { AppendArgs, EventStore } from "../storage/event-store.ts";
import { DEFAULT_PERSONAL_CATEGORY as D } from "../storage/personal-key-store.ts";
import { pendingEvent, testPersonalKey } from "./fixtures.ts";

export interface EventStoreContractArgs {
  /**
   * Fresh, empty storage: the contract appends through its event store, and checks what an
   * append names against its keys and persons.
   */
  readonly create: () => Promise<Storage>;
  /**
   * `false` skips the cases where an append waits on a transaction the test holds open, for a
   * storage whose calls cannot wait on one another, as a Durable Object's called from outside.
   */
  readonly concurrent?: boolean;
}

export interface EventStoreContractFunction {
  (args: EventStoreContractArgs): void;
}

const now = new Date("2026-01-01T00:00:00.000Z");

/**
 * The behaviour every event store must exhibit. Call it inside a `describe` of the adapter's
 * test file with a factory that returns fresh, empty storage.
 */
export const eventStoreContract: EventStoreContractFunction = ({ create, concurrent = true }) => {
  describe("event store contract", () => {
    let storage: Storage;
    let store: EventStore;

    beforeEach(async () => {
      storage = await create();
      store = storage.eventStore;
    });

    const naming = (
      version: number,
      names: Pick<AppendArgs, "persons" | "touches" | "seals">,
      target: EventStore = store,
    ) =>
      target.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: version - 1,
        events: [pendingEvent({ aggregateId: "1", version })],
        ...names,
      });

    const holding = () => {
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { held, release };
    };

    it("appends only while each person it names with a key still holds that key", async () => {
      await storage.personalKeys.add("c-1", D, testPersonalKey("one"));
      const first = { person: "c-1", fingerprint: testPersonalKey("one").fingerprint };
      await naming(1, { persons: [first, { person: "c-2", fingerprint: null }] });
      await storage.personalKeys.remove("c-1", "f-one");
      const refused = await naming(2, { persons: [first] }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ForgottenSinceLoadError);
      expect(refused).toBeInstanceOf(ConcurrencyError);
      expect(refused).toMatchObject({
        code: "CONCURRENCY_CONFLICT",
        personId: "c-1",
        streamId: "order:1",
        expectedVersion: 1,
        actualVersion: 1,
      });
      await storage.personalKeys.add("c-1", D, testPersonalKey("two"));
      await expect(naming(2, { persons: [first] })).rejects.toBeInstanceOf(ForgottenSinceLoadError);
      await expect(
        storage.transact((tx) => naming(2, { persons: [first] }, tx.eventStore)),
      ).rejects.toBeInstanceOf(ForgottenSinceLoadError);
      expect(await store.lastPosition()).toBe(1);
      await naming(2, {
        persons: [{ person: "c-1", fingerprint: testPersonalKey("two").fingerprint }],
      });
      expect((await store.load({ aggregateType: "order", aggregateId: "1" })).version).toBe(2);
    });

    it("appends on a key kept past a forgetting only for what was read from it once kept", async () => {
      await storage.personalKeys.add("c-1", "invoices", testPersonalKey("one"));
      const read = { person: "c-1", fingerprint: testPersonalKey("one").fingerprint };
      await naming(1, { persons: [read] });
      await storage.personalKeys.retain("c-1", "f-one", {
        since: "2026-02-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      await expect(naming(2, { persons: [read] })).rejects.toBeInstanceOf(ForgottenSinceLoadError);
      await naming(2, { persons: [{ ...read, retained: true }] });
      await storage.personalKeys.remove("c-1", "f-one");
      await expect(naming(3, { persons: [{ ...read, retained: true }] })).rejects.toBeInstanceOf(
        ForgottenSinceLoadError,
      );
      expect((await store.load({ aggregateType: "order", aggregateId: "1" })).version).toBe(2);
    });

    it("refuses to seal under a key whose category is restricted, or whose person is as a whole, and lets reads of it through", async () => {
      await storage.personalKeys.add("c-1", "marketing", testPersonalKey("one"));
      await storage.personalKeys.add("c-1", "profile", testPersonalKey("two"));
      const marketing = { person: "c-1", fingerprint: testPersonalKey("one").fingerprint };
      const profile = { person: "c-1", fingerprint: testPersonalKey("two").fingerprint };
      await storage.persons.restrict("c-1", {
        ground: "objection-pending",
        categories: ["marketing"],
        since: now,
      });
      await expect(naming(1, { seals: [marketing] })).rejects.toMatchObject({
        code: "PROCESSING_RESTRICTED",
        personId: "c-1",
      });
      await naming(1, { seals: [profile], persons: [marketing], touches: ["c-1"] });
      await storage.persons.restrict("c-1", {
        ground: "legal-claims",
        categories: null,
        since: now,
      });
      await expect(naming(2, { seals: [profile] })).rejects.toBeInstanceOf(
        ProcessingRestrictedError,
      );
      await storage.persons.unrestrict("c-1", { categories: null });
      await naming(2, { seals: [marketing, profile], touches: ["c-1"] });
      await storage.personalKeys.remove("c-1", marketing.fingerprint);
      await expect(naming(3, { seals: [marketing] })).rejects.toBeInstanceOf(
        ForgottenSinceLoadError,
      );
      expect(await store.lastPosition()).toBe(2);
    });

    it("refuses to append while a person it touches is restricted, before any key it names", async () => {
      await storage.persons.restrict("c-1", {
        ground: "accuracy-contested",
        categories: null,
        since: now,
      });
      const refused = await naming(1, {
        touches: ["c-2", "c-1"],
        persons: [{ person: "c-1", fingerprint: "a key never held" }],
      }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ProcessingRestrictedError);
      expect(refused).toMatchObject({ code: "PROCESSING_RESTRICTED", personId: "c-1" });
      await expect(
        storage.transact((tx) => naming(1, { touches: ["c-1"] }, tx.eventStore)),
      ).rejects.toBeInstanceOf(ProcessingRestrictedError);
      expect(await store.lastPosition()).toBe(0);
      await naming(1, { touches: ["c-2"] });
      await storage.persons.unrestrict("c-1", { categories: null });
      await naming(2, { touches: ["c-1", "c-2"] });
      expect(await store.lastPosition()).toBe(2);
    });

    it.skipIf(!concurrent)(
      "refuses an append that a transaction restricting its person held up",
      async () => {
        const { held, release } = holding();
        let restricted = (): void => {};
        const restricting = new Promise<void>((resolve) => {
          restricted = resolve;
        });
        const restriction = storage.transact(async (tx) => {
          await tx.persons.restrict("c-1", {
            ground: "accuracy-contested",
            categories: null,
            since: now,
          });
          restricted();
          await held;
        });
        await restricting;
        const append = naming(1, { touches: ["c-1"] });
        release();
        await restriction;
        await expect(append).rejects.toBeInstanceOf(ProcessingRestrictedError);
        expect(await store.lastPosition()).toBe(0);
      },
    );

    it.skipIf(!concurrent)(
      "refuses an append that a transaction forgetting its person held up",
      async () => {
        await storage.personalKeys.add("c-1", D, testPersonalKey("one"));
        const { held, release } = holding();
        let removed = (): void => {};
        const removing = new Promise<void>((resolve) => {
          removed = resolve;
        });
        const forget = storage.transact(async (tx) => {
          await tx.personalKeys.remove("c-1", "f-one");
          removed();
          await held;
        });
        await removing;
        const append = naming(1, {
          persons: [{ person: "c-1", fingerprint: testPersonalKey("one").fingerprint }],
        });
        release();
        await forget;
        await expect(append).rejects.toBeInstanceOf(ForgottenSinceLoadError);
        expect(await store.lastPosition()).toBe(0);
      },
    );

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

    it("appends more events than one statement carries, each at its position, in order", async () => {
      const events = Array.from({ length: 30 }, (_, index) =>
        pendingEvent({
          aggregateId: "1",
          version: index + 1,
          payload: { index },
          person: index % 3 === 0 ? `c-${index}` : null,
        }),
      );
      const result = await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events,
      });
      expect(result.version).toBe(30);
      expect(result.events.map((event) => event.position)).toEqual(
        events.map((_, index) => index + 1),
      );
      expect(result.events.map((event) => event.payload)).toEqual(events.map((e) => e.payload));
      const loaded = await store.load({ aggregateType: "order", aggregateId: "1" });
      expect(loaded.version).toBe(30);
      expect(loaded.events.map((event) => [event.version, event.position])).toEqual(
        events.map((_, index) => [index + 1, index + 1]),
      );
      expect(loaded.events.map((event) => event.person)).toEqual(events.map((e) => e.person));
    });

    it("loads a stream with its version and preserves every field, in the global stream too", async () => {
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
          causationId: "evt-0",
          commandId: "cmd-1",
          actor: "user-1",
          depth: 0,
          schemaVersion: 1,
          system: false,
        },
      });
      expect(await store.readAll({ afterPosition: 0, limit: 10 })).toEqual(loaded.events);
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

    it("reads one event of a stream by its id, and null for an id the stream does not hold", async () => {
      await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [1, 2, 3].map((version) => pendingEvent({ aggregateId: "1", version })),
      });
      await store.append({
        aggregateType: "customer",
        aggregateId: "1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateType: "customer", aggregateId: "1", version: 1 })],
      });
      const { events } = await store.load({ aggregateType: "order", aggregateId: "1" });
      expect(
        await store.readOne({ aggregateType: "order", aggregateId: "1", eventId: "order-1-2" }),
      ).toEqual(events[1]);
      for (const missing of [
        { aggregateType: "order", aggregateId: "1", eventId: "order-1-4" },
        { aggregateType: "order", aggregateId: "1", eventId: "customer-1-1" },
        { aggregateType: "order", aggregateId: "2", eventId: "order-1-2" },
        { aggregateType: "customer", aggregateId: "1", eventId: "order-1-2" },
      ]) {
        expect(await store.readOne(missing)).toBeNull();
      }
    });

    it("stores any JSON payload, a top-level boolean or array of booleans included", async () => {
      const payloads: readonly unknown[] = [true, [true, false], "plain", 0];
      await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: payloads.map((payload, index) =>
          pendingEvent({ aggregateId: "1", version: index + 1, payload }),
        ),
      });
      const { events } = await store.load({ aggregateType: "order", aggregateId: "1" });
      expect(events.map((event) => event.payload)).toEqual(payloads);
    });

    it("hands out events that changing does not change the store, their payload as JSON", async () => {
      const at = new Date("2026-01-01T00:00:00.000Z");
      const appended = await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [
          pendingEvent({
            aggregateId: "1",
            version: 1,
            payload: { at, lines: ["a"] },
          }),
        ],
      });
      expect(appended.events[0]?.payload).toEqual({ at, lines: ["a"] });
      const [first] = (await store.load({ aggregateType: "order", aggregateId: "1" })).events;
      if (first === undefined) throw new Error("the event was not stored");
      expect(first.payload).toEqual({ at: "2026-01-01T00:00:00.000Z", lines: ["a"] });
      (first.payload as { lines: string[] }).lines.push("b");
      const [again] = await store.readAll({ afterPosition: 0, limit: 10 });
      expect(again?.payload).toEqual({ at: "2026-01-01T00:00:00.000Z", lines: ["a"] });
    });

    it("refuses a payload with no JSON, and appends nothing", async () => {
      await expect(
        store.append({
          aggregateType: "order",
          aggregateId: "1",
          expectedVersion: 0,
          events: [{ ...pendingEvent({ aggregateId: "1", version: 1 }), payload: undefined }],
        }),
      ).rejects.toThrow();
      expect(await store.lastPosition()).toBe(0);
    });

    it("reports only the version when loading from past any head, however far", async () => {
      await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [1, 2].map((version) => pendingEvent({ aggregateId: "1", version })),
      });
      for (const fromVersion of [3, Number.MAX_SAFE_INTEGER]) {
        expect(await store.load({ aggregateType: "order", aggregateId: "1", fromVersion })).toEqual(
          {
            events: [],
            version: 2,
          },
        );
      }
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

    it("keeps the person an event names, and reads a person's events in position order, committed only", async () => {
      await store.append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: 0,
        events: [
          pendingEvent({
            aggregateType: "customer",
            aggregateId: "c-1",
            version: 1,
            type: "CustomerRegistered",
            person: "c-1",
          }),
        ],
      });
      await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [
          pendingEvent({ aggregateId: "1", version: 1, person: "c-2" }),
          pendingEvent({ aggregateId: "1", version: 2, type: "OrderNoted", person: "c-1" }),
          pendingEvent({ aggregateId: "1", version: 3, type: "OrderPaid" }),
        ],
      });
      const appended = await store.append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: 1,
        events: [
          pendingEvent({
            aggregateType: "customer",
            aggregateId: "c-1",
            version: 2,
            type: "CustomerMoved",
            person: "c-1",
          }),
        ],
      });
      expect(appended.events[0]?.person).toBe("c-1");
      const loaded = await store.load({ aggregateType: "order", aggregateId: "1" });
      expect(loaded.events.map((event) => event.person)).toEqual(["c-2", "c-1", null]);
      expect((await store.readAll({ afterPosition: 0, limit: 10 })).map((e) => e.person)).toEqual([
        "c-1",
        "c-2",
        "c-1",
        null,
        "c-1",
      ]);

      const theirs = await store.readByPerson({ person: "c-1", afterPosition: 0, limit: 10 });
      expect(theirs.map((event) => [event.type, event.position])).toEqual([
        ["CustomerRegistered", 1],
        ["OrderNoted", 3],
        ["CustomerMoved", 5],
      ]);
      expect(theirs[1]).toEqual(loaded.events[1]);
      const page = await store.readByPerson({ person: "c-1", afterPosition: 1, limit: 1 });
      expect(page.map((event) => event.position)).toEqual([3]);
      expect(await store.readByPerson({ person: "c-1", afterPosition: 5, limit: 10 })).toEqual([]);
      expect(await store.readByPerson({ person: "c-3", afterPosition: 0, limit: 10 })).toEqual([]);
    });

    it("reseals events in place, their position and the rest kept, and finds them by their new person", async () => {
      await store.append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: 0,
        events: [
          pendingEvent({
            aggregateType: "customer",
            aggregateId: "c-1",
            version: 1,
            type: "CustomerRegistered",
            payload: { email: "ada@example.com" },
          }),
          pendingEvent({
            aggregateType: "customer",
            aggregateId: "c-1",
            version: 2,
            type: "CustomerMoved",
            payload: { city: "Bilbao" },
            person: "c-2",
          }),
          pendingEvent({
            aggregateType: "customer",
            aggregateId: "c-1",
            version: 3,
            type: "CustomerNoted",
            payload: {},
            person: "c-2",
          }),
        ],
      });
      await store.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "1", version: 1 })],
      });
      const [registered, moved, noted, placed] = await store.readAll({
        afterPosition: 0,
        limit: 10,
      });
      const sealed = { $personal: { person: "c-1", key: "k", iv: "iv", data: "data" } };
      await store.reseal([
        { position: 1, payload: { email: sealed }, person: "c-1" },
        { position: 2, payload: { city: "Bilbao" }, person: null },
        { position: 99, payload: { lost: true }, person: "c-1" },
      ]);

      const written = await store.readAll({ afterPosition: 0, limit: 10 });
      expect(written).toEqual([
        { ...registered, payload: { email: sealed }, person: "c-1" },
        { ...moved, person: null },
        noted,
        placed,
      ]);
      expect(await store.load({ aggregateType: "customer", aggregateId: "c-1" })).toEqual({
        events: written.slice(0, 3),
        version: 3,
      });
      expect(
        await store.readOne({
          aggregateType: "customer",
          aggregateId: "c-1",
          eventId: String(registered?.id),
        }),
      ).toEqual(written[0]);
      expect(await store.readByPerson({ person: "c-1", afterPosition: 0, limit: 10 })).toEqual([
        written[0],
      ]);
      expect(await store.readByPerson({ person: "c-2", afterPosition: 0, limit: 10 })).toEqual([
        noted,
      ]);
      await store.reseal([{ position: 4, payload: placed?.payload, person: "c-1" }]);
      expect(
        (await store.readByPerson({ person: "c-1", afterPosition: 0, limit: 10 })).map(
          (event) => event.position,
        ),
      ).toEqual([1, 4]);
      expect(await store.lastPosition()).toBe(4);
    });

    it("reseals nothing for an empty list", async () => {
      await naming(1, {});
      const before = await store.readAll({ afterPosition: 0, limit: 10 });
      await store.reseal([]);
      expect(await store.readAll({ afterPosition: 0, limit: 10 })).toEqual(before);
    });

    it("starts the global stream at position 0", async () => {
      expect(await store.lastPosition()).toBe(0);
      expect(await store.readAll({ afterPosition: 0, limit: 10 })).toEqual([]);
    });
  });
};
