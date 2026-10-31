import { describe, expect, it } from "vitest";
import type { KeyedPerson, PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { ConcurrencyError, ValidationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { generatePersonalKey, isSealed } from "./crypto.ts";
import { withPersonalData } from "./event-store.ts";

const registry: Registry = {
  aggregates: {
    customer: {
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ email: personal(z.email()), plan: z.string() }),
          evolve: () => ({}),
        },
        customerRenamed: { evolve: () => ({}) },
      },
      commands: {},
      policies: {},
      processes: {},
    },
    order: {
      events: {
        orderPlaced: {
          payload: ({ z, personal, person }: EventPayloadArgs) =>
            z.object({
              customerId: person(z.string()),
              note: personal(z.string()).optional(),
              address: personal(z.object({ street: z.string() })),
              total: z.number(),
            }),
          evolve: () => ({}),
        },
      },
      commands: {},
      policies: {},
      processes: {},
    },
  },
  readModels: {},
};

const setup = async () => {
  const storage = await memory().createStorage({ logger: silentLogger });
  const calls: string[] = [];
  const keys: PersonalKeyStore = {
    get: async (person) => {
      calls.push(`get:${person}`);
      return storage.personalKeys.get(person);
    },
    add: async (person, key) => {
      calls.push(`add:${person}`);
      return storage.personalKeys.add(person, key);
    },
    remove: (person) => storage.personalKeys.remove(person),
  };
  const store = withPersonalData({
    eventStore: storage.eventStore,
    aggregates: buildAggregates({ registry, ports: {} }),
    keys,
  });
  const registered = (version: number, email: string) =>
    pendingEvent({
      aggregateType: "customer",
      aggregateId: "c-1",
      version,
      type: "CustomerRegistered",
      payload: { email, plan: "pro" },
    });
  const placed = (payload: object, aggregateId = "o-1") =>
    pendingEvent({ aggregateType: "order", aggregateId, version: 1, type: "OrderPlaced", payload });
  return { storage, store, calls, registered, placed };
};

describe("withPersonalData", () => {
  it("stores the personal fields sealed under the aggregate's id and reads them back in the clear", async () => {
    const { storage, store, registered } = await setup();
    const appended = await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [registered(1, "ana@example.com")],
    });
    expect(appended.events[0]?.payload).toEqual({ email: "ana@example.com", plan: "pro" });
    const [stored] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    const payload = stored?.payload as { email: unknown; plan: string };
    expect(payload.plan).toBe("pro");
    expect(isSealed(payload.email)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("ana@example.com");
    expect((payload.email as { $personal: { person: string } }).$personal.person).toBe("c-1");
    expect((await storage.personalKeys.get("c-1"))?.fingerprint).toHaveLength(44);
    const loaded = await store.load({ aggregateType: "customer", aggregateId: "c-1" });
    expect(loaded.events[0]?.payload).toEqual({ email: "ana@example.com", plan: "pro" });
    expect((await store.readAll({ afterPosition: 0, limit: 10 }))[0]?.payload).toEqual({
      email: "ana@example.com",
      plan: "pro",
    });
  });

  it("seals under the person the payload names, leaves an absent optional field out, and seals an object whole", async () => {
    const { storage, store, placed } = await setup();
    await store.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [placed({ customerId: "c-7", address: { street: "Main 1" }, total: 10 })],
    });
    const [stored] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    const payload = stored?.payload as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["customerId", "address", "total"]);
    expect(payload.customerId).toBe("c-7");
    expect(isSealed(payload.address)).toBe(true);
    expect((payload.address as { $personal: { person: string } }).$personal.person).toBe("c-7");
    expect((await storage.personalKeys.get("c-7"))?.fingerprint).toHaveLength(44);
    expect(await storage.personalKeys.get("o-1")).toBeNull();
    const loaded = await store.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.events[0]?.payload).toEqual({
      customerId: "c-7",
      address: { street: "Main 1" },
      total: 10,
    });
  });

  it("reads a forgotten person's fields as null and keeps the rest", async () => {
    const { storage, store, registered, placed } = await setup();
    await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [registered(1, "ana@example.com")],
    });
    await store.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [
        placed({ customerId: "c-1", note: "ring twice", address: { street: "x" }, total: 1 }),
      ],
    });
    await storage.personalKeys.remove("c-1");
    const all = await store.readAll({ afterPosition: 0, limit: 10 });
    expect(all.map((event) => event.payload)).toEqual([
      { email: null, plan: "pro" },
      { customerId: "c-1", note: null, address: null, total: 1 },
    ]);
    const loaded = await store.load({ aggregateType: "customer", aggregateId: "c-1" });
    expect(loaded.fingerprints).toEqual(new Map());
  });

  it("reads what was sealed under a key the person no longer has as null, next to what their new key opens", async () => {
    const { storage, store, registered } = await setup();
    await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [registered(1, "ana@example.com")],
    });
    await storage.personalKeys.remove("c-1");
    await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 1,
      events: [registered(2, "ana@again.example")],
    });
    const loaded = await store.load({ aggregateType: "customer", aggregateId: "c-1" });
    expect(loaded.events.map((event) => (event.payload as { email: unknown }).email)).toEqual([
      null,
      "ana@again.example",
    ]);
    const again = await storage.personalKeys.get("c-1");
    expect(loaded.fingerprints).toEqual(new Map([["c-1", again?.fingerprint]]));
  });

  it("seals a person the events were decided on only under the key they were read under", async () => {
    const { storage, store, calls, registered } = await setup();
    await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [registered(1, "ana@example.com")],
    });
    const { fingerprints } = await store.load({ aggregateType: "customer", aggregateId: "c-1" });
    const read = [
      { person: "c-2", fingerprint: "another key" },
      { person: "c-1", fingerprint: fingerprints?.get("c-1") ?? "" },
    ];
    const append = (version: number, persons: readonly KeyedPerson[]) =>
      store.append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: version - 1,
        events: [registered(version, "ana@example.com")],
        persons,
      });
    await append(2, read);
    await storage.personalKeys.remove("c-1");
    calls.length = 0;
    const refused = await append(3, read).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConcurrencyError);
    expect(refused).toMatchObject({
      code: "CONCURRENCY_CONFLICT",
      streamId: "customer:c-1",
      expectedVersion: 2,
      actualVersion: 2,
      message: "Person c-1 was forgotten since customer:c-1 was loaded at version 2",
    });
    expect(calls).toEqual(["get:c-1"]);
    expect(await storage.personalKeys.get("c-1")).toBeNull();

    const fresh = await generatePersonalKey();
    await storage.personalKeys.add("c-1", fresh);
    await expect(append(3, read)).rejects.toBeInstanceOf(ConcurrencyError);
    await expect(
      append(3, [...read, { person: "c-1", fingerprint: fresh.fingerprint }]),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    expect(await storage.personalKeys.get("c-1")).toEqual(fresh);
    expect(
      (await storage.eventStore.load({ aggregateType: "customer", aggregateId: "c-1" })).version,
    ).toBe(2);

    await append(3, [{ person: "c-1", fingerprint: fresh.fingerprint }, ...read.slice(0, 1)]);
    await append(4, [{ person: "c-1", fingerprint: null }]);
    await storage.personalKeys.remove("c-1");
    await append(5, [{ person: "c-1", fingerprint: null }]);
    const created = await storage.personalKeys.get("c-1");
    expect(created?.fingerprint).not.toBe(fresh.fingerprint);
    const loaded = await store.load({ aggregateType: "customer", aggregateId: "c-1" });
    expect(loaded.events.map((event) => (event.payload as { email: unknown }).email)).toEqual([
      null,
      null,
      null,
      null,
      "ana@example.com",
    ]);
  });

  it("reuses a person's key across events and appends, and fetches it once per call", async () => {
    const { storage, store, calls, registered } = await setup();
    await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [registered(1, "ana@example.com"), registered(2, "ana@other.example")],
    });
    expect(calls).toEqual(["get:c-1", "add:c-1"]);
    await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 2,
      events: [registered(3, "ana@third.example")],
    });
    expect(calls).toEqual(["get:c-1", "add:c-1", "get:c-1"]);
    calls.length = 0;
    const loaded = await store.load({ aggregateType: "customer", aggregateId: "c-1" });
    expect(loaded.events.map((event) => (event.payload as { email: string }).email)).toEqual([
      "ana@example.com",
      "ana@other.example",
      "ana@third.example",
    ]);
    expect(calls).toEqual(["get:c-1"]);
    const persons = new Set(
      (await storage.eventStore.readAll({ afterPosition: 0, limit: 10 })).map(
        (event) =>
          (event.payload as { email: { $personal: { person: string } } }).email.$personal.person,
      ),
    );
    expect(persons).toEqual(new Set(["c-1"]));
  });

  it("keeps the key another writer added first", async () => {
    const { storage, store, registered } = await setup();
    const first = { key: "Zmlyc3Q=", fingerprint: "first" };
    await storage.personalKeys.add("c-1", first);
    const concurrentKeys: PersonalKeyStore = {
      get: async () => null,
      add: (person, key) => storage.personalKeys.add(person, key),
      remove: (person) => storage.personalKeys.remove(person),
    };
    await expect(
      withPersonalData({
        eventStore: storage.eventStore,
        aggregates: buildAggregates({ registry, ports: {} }),
        keys: concurrentKeys,
      }).append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: 0,
        events: [registered(1, "ana@example.com")],
      }),
    ).rejects.toThrow();
    expect(await storage.personalKeys.get("c-1")).toEqual(first);
    void store;
  });

  it("leaves events without personal fields, and of aggregates it does not know, as they are", async () => {
    const { storage, store, calls } = await setup();
    const plain = [
      pendingEvent({
        aggregateType: "customer",
        aggregateId: "c-1",
        version: 1,
        type: "CustomerRenamed",
        payload: { name: "Ana" },
      }),
    ];
    await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: plain,
    });
    await store.append({
      aggregateType: "process:x",
      aggregateId: "p-1",
      expectedVersion: 0,
      events: [
        pendingEvent({
          aggregateType: "process:x",
          aggregateId: "p-1",
          version: 1,
          type: "ProcessStarted",
          payload: "text",
        }),
      ],
    });
    expect(calls).toEqual([]);
    const all = await store.readAll({ afterPosition: 0, limit: 10 });
    expect(all.map((event) => event.payload)).toEqual([{ name: "Ana" }, "text"]);
    expect(await storage.eventStore.readAll({ afterPosition: 0, limit: 10 })).toEqual(all);
    expect(await store.lastPosition()).toBe(2);
  });

  it("refuses an event whose person field is empty", async () => {
    const { store, placed } = await setup();
    await expect(
      store.append({
        aggregateType: "order",
        aggregateId: "o-1",
        expectedVersion: 0,
        events: [placed({ customerId: "", address: { street: "x" }, total: 1 })],
      }),
    ).rejects.toThrow(
      new ValidationError('Event OrderPlaced of order:o-1 names no person in "customerId"', [
        { path: ["customerId"], message: "Expected a non-empty string" },
      ]),
    );
  });

  it("refuses an event whose person field is not a string or a number", async () => {
    const { store, placed } = await setup();
    await expect(
      store.append({
        aggregateType: "order",
        aggregateId: "o-1",
        expectedVersion: 0,
        events: [placed({ customerId: { id: "c-1" }, address: { street: "x" }, total: 1 })],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("takes a number for a person's id", async () => {
    const { storage, store, placed } = await setup();
    await store.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [placed({ customerId: 42, address: { street: "x" }, total: 1 })],
    });
    expect((await storage.personalKeys.get("42"))?.fingerprint).toHaveLength(44);
  });
});
