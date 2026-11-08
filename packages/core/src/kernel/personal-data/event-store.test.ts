import { describe, expect, it } from "vitest";
import { ForgottenSinceLoadError } from "../../adapter/storage/append-checks.ts";
import type { AppendArgs } from "../../adapter/storage/event-store.ts";
import type { KeyedPerson, PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import {
  ConcurrencyError,
  ProcessingRestrictedError,
  ValidationError,
} from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import type { EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { withUpcasting } from "../aggregate/upcasting.ts";
import { generatePersonalKey, isSealed } from "./crypto.ts";
import { openedUnder, withPersonalData } from "./event-store.ts";

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
  const storage = await memory().createStorage();
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
    listWrappedUnder: (args) => storage.personalKeys.listWrappedUnder(args),
    rewrap: (person, from, to) => storage.personalKeys.rewrap(person, from, to),
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
    const stream = { aggregateType: "customer", aggregateId: "c-1" };
    expect((await store.readOne({ ...stream, eventId: stored?.id ?? "" }))?.payload).toEqual({
      email: "ana@example.com",
      plan: "pro",
    });
    expect(await store.readOne({ ...stream, eventId: "missing" })).toBeNull();
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
    const other = await generatePersonalKey();
    await storage.personalKeys.add("c-2", other);
    const read = [
      { person: "c-2", fingerprint: other.fingerprint },
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

  it("fails as a conflict when the key it sealed under is removed before the store writes", async () => {
    const { storage, registered } = await setup();
    await storage.personalKeys.add("c-1", await generatePersonalKey());
    const forgetting: PersonalKeyStore = {
      ...storage.personalKeys,
      get: async (person) => {
        const read = await storage.personalKeys.get(person);
        await storage.personalKeys.remove(person);
        return read;
      },
    };
    const refused = await withPersonalData({
      eventStore: storage.eventStore,
      aggregates: buildAggregates({ registry, ports: {} }),
      keys: forgetting,
    })
      .append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: 0,
        events: [registered(1, "ana@example.com")],
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ForgottenSinceLoadError);
    expect(refused).toMatchObject({ code: "CONCURRENCY_CONFLICT", personId: "c-1" });
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("refuses events of a person restricted after it read their key, and of one it touches", async () => {
    const { storage, store, registered, placed } = await setup();
    const restricting: PersonalKeyStore = {
      ...storage.personalKeys,
      get: async (person) => {
        await storage.persons.restrict(person, new Date());
        return storage.personalKeys.get(person);
      },
    };
    const refused = await withPersonalData({
      eventStore: storage.eventStore,
      aggregates: buildAggregates({ registry, ports: {} }),
      keys: restricting,
    })
      .append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: 0,
        events: [registered(1, "ana@example.com")],
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProcessingRestrictedError);
    expect(refused).toMatchObject({ personId: "c-1" });
    await storage.persons.restrict("c-9", new Date());
    await expect(
      store.append({
        aggregateType: "order",
        aggregateId: "o-1",
        expectedVersion: 0,
        events: [placed({ customerId: "c-2", address: { street: "Main" }, total: 1 })],
        touches: ["c-9"],
      }),
    ).rejects.toMatchObject({ personId: "c-9" });
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("hands the store every person it read, sealed or touched", async () => {
    const { storage, placed } = await setup();
    const appended: AppendArgs[] = [];
    const recording = withPersonalData({
      eventStore: {
        ...storage.eventStore,
        append: (args) => {
          appended.push(args);
          return storage.eventStore.append(args);
        },
      },
      aggregates: buildAggregates({ registry, ports: {} }),
      keys: storage.personalKeys,
    });
    const read = { person: "c-3", fingerprint: null };
    await recording.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [placed({ customerId: "c-2", address: { street: "Main" }, total: 1 })],
      persons: [read],
      touches: ["c-4"],
    });
    const key = await storage.personalKeys.get("c-2");
    expect(appended[0]?.persons).toEqual([read, { person: "c-2", fingerprint: key?.fingerprint }]);
    expect(appended[0]?.touches).toEqual(["c-4", "c-2"]);
    await recording.append({
      aggregateType: "order",
      aggregateId: "o-2",
      expectedVersion: 0,
      events: [placed({ customerId: "c-5", total: 1 }, "o-2")].map((event) => ({
        ...event,
        payload: { customerId: "c-5", total: 1 },
      })),
    });
    expect(appended[1]?.persons).toEqual([]);
    expect(appended[1]?.touches).toEqual(["c-5"]);
  });

  it("tells the key it opened each event it hands out under, through an upcast too", async () => {
    const storage = await memory().createStorage();
    const upcast = {
      aggregates: {
        customer: {
          ...registry.aggregates.customer,
          upcasts: {
            customerRegistered: {
              upcasts: [(payload: { email: string }) => ({ ...payload, plan: "free" })],
            },
          },
        },
      },
      readModels: {},
    } as Registry;
    const aggregates = buildAggregates({ registry: upcast, ports: {} });
    const sealing = withPersonalData({
      eventStore: storage.eventStore,
      aggregates,
      keys: storage.personalKeys,
    });
    const store = withUpcasting({ eventStore: sealing, aggregates });
    await sealing.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [
        pendingEvent({
          aggregateType: "customer",
          aggregateId: "c-1",
          version: 1,
          type: "CustomerRegistered",
          payload: { email: "ana@example.com" },
        }),
        pendingEvent({
          aggregateType: "customer",
          aggregateId: "c-1",
          version: 2,
          type: "CustomerRenamed",
          payload: { name: "Ana" },
        }),
      ],
    });
    const key = await storage.personalKeys.get("c-1");
    const read = [{ person: "c-1", fingerprint: key?.fingerprint }];
    const [registered, renamed] = await store.readAll({ afterPosition: 0, limit: 10 });
    expect(registered?.payload).toEqual({ email: "ana@example.com", plan: "free" });
    expect(openedUnder(registered as StoredEvent)).toEqual(read);
    expect(openedUnder(renamed as StoredEvent)).toEqual([]);
    const one = await store.readOne({
      aggregateType: "customer",
      aggregateId: "c-1",
      eventId: registered?.id ?? "",
    });
    expect(openedUnder(one as StoredEvent)).toEqual(read);
    await storage.personalKeys.remove("c-1");
    const [forgotten] = await store.readAll({ afterPosition: 0, limit: 1 });
    expect(openedUnder(forgotten as StoredEvent)).toEqual([]);
  });

  it("keeps the key another writer added first", async () => {
    const { storage, store, registered } = await setup();
    const first = { key: "Zmlyc3Q=", fingerprint: "first", kid: null };
    await storage.personalKeys.add("c-1", first);
    const concurrentKeys: PersonalKeyStore = {
      get: async () => null,
      add: (person, key) => storage.personalKeys.add(person, key),
      remove: (person) => storage.personalKeys.remove(person),
      listWrappedUnder: (args) => storage.personalKeys.listWrappedUnder(args),
      rewrap: (person, from, to) => storage.personalKeys.rewrap(person, from, to),
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

  it("names the person on the event it seals, with every marked field absent too, and reads their events by person", async () => {
    const { storage, store, registered, placed } = await setup();
    const appended = await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [registered(1, "ana@example.com")],
    });
    expect(appended.events[0]?.person).toBe("c-1");
    await store.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [placed({ customerId: "c-1", address: { street: "x" }, total: 1 })],
    });
    await store.append({
      aggregateType: "order",
      aggregateId: "o-2",
      expectedVersion: 0,
      events: [placed({ customerId: "c-2", total: 2 }, "o-2")],
    });
    await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 1,
      events: [
        pendingEvent({
          aggregateType: "customer",
          aggregateId: "c-1",
          version: 2,
          type: "CustomerRenamed",
          payload: { name: "Ana" },
        }),
      ],
    });
    const stored = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(stored.map((event) => event.person)).toEqual(["c-1", "c-1", "c-2", null]);

    const read = await store.readByPerson({ person: "c-1", afterPosition: 0, limit: 10 });
    expect(read.map((event) => [event.position, event.payload])).toEqual([
      [1, { email: "ana@example.com", plan: "pro" }],
      [2, { customerId: "c-1", address: { street: "x" }, total: 1 }],
    ]);
    await storage.personalKeys.remove("c-1");
    const after = await store.readByPerson({ person: "c-1", afterPosition: 1, limit: 10 });
    expect(after.map((event) => event.payload)).toEqual([
      { customerId: "c-1", address: null, total: 1 },
    ]);
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

  it("refuses an event that carries an envelope, in a marked field or any other", async () => {
    const { store, placed, registered } = await setup();
    const envelope = { $personal: { person: "c-9", key: "k", iv: "iv", data: "d" } };
    const refusal = (type: string, stream: string, field: string) =>
      new ValidationError(
        `Event ${type} of ${stream} carries a sealed value in "${field}": personal fields are sealed by the runtime, never by a handler`,
        [{ path: [field], message: "Expected a value, not an envelope" }],
      );
    await expect(
      store.append({
        aggregateType: "order",
        aggregateId: "o-1",
        expectedVersion: 0,
        events: [placed({ customerId: "c-1", address: envelope, total: 1 })],
      }),
    ).rejects.toThrow(refusal("OrderPlaced", "order:o-1", "address"));
    await expect(
      store.append({
        aggregateType: "order",
        aggregateId: "o-1",
        expectedVersion: 0,
        events: [placed({ customerId: "c-1", address: { street: "x" }, total: envelope })],
      }),
    ).rejects.toThrow(refusal("OrderPlaced", "order:o-1", "total"));
    await expect(
      store.append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: 0,
        events: [
          {
            ...registered(1, "ana@example.com"),
            type: "CustomerRenamed",
            payload: { to: envelope },
          },
        ],
      }),
    ).rejects.toThrow(refusal("CustomerRenamed", "customer:c-1", "to"));
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
