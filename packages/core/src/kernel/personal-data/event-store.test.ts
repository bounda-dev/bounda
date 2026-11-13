import { describe, expect, it } from "vitest";
import { ForgottenSinceLoadError } from "../../adapter/storage/append-checks.ts";
import type { AppendArgs } from "../../adapter/storage/event-store.ts";
import {
  DEFAULT_PERSONAL_CATEGORY,
  type KeyedPerson,
  type PersonalKeyStore,
  type SealedValue,
} from "../../adapter/storage/personal-key-store.ts";
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
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { keysOver, newStoredKey, removeKeys } from "../test-support.ts";
import { isSealed } from "./crypto.ts";
import {
  hidingRetained,
  openedUnder,
  retainedHidden,
  withoutRetained,
  withPersonalData,
} from "./event-store.ts";

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
        customerBilled: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({
              name: personal(z.string(), { category: "profile" }),
              iban: personal(z.string(), { category: "invoices" }),
              email: personal(z.email()).optional(),
            }),
          evolve: () => ({}),
        },
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
    ...storage.personalKeys,
    get: async (person, category) => {
      calls.push(`get:${person}`);
      return storage.personalKeys.get(person, category);
    },
    find: async (person, fingerprint) => {
      calls.push(`find:${person}`);
      return storage.personalKeys.find(person, fingerprint);
    },
    add: async (person, category, key) => {
      calls.push(`add:${person}`);
      return storage.personalKeys.add(person, category, key);
    },
  };
  const store = withPersonalData({
    eventStore: storage.eventStore,
    aggregates: buildAggregates({ registry, ports: {} }),
    processes: { byName: {} },
    keys: keysOver(keys),
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
    expect(
      (await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY))?.fingerprint,
    ).toHaveLength(24);
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
    expect(
      (await storage.personalKeys.get("c-7", DEFAULT_PERSONAL_CATEGORY))?.fingerprint,
    ).toHaveLength(24);
    expect(await storage.personalKeys.get("o-1", DEFAULT_PERSONAL_CATEGORY)).toBeNull();
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
    await removeKeys(storage.personalKeys, "c-1");
    const all = await store.readAll({ afterPosition: 0, limit: 10 });
    expect(all.map((event) => event.payload)).toEqual([
      { email: null, plan: "pro" },
      { customerId: "c-1", note: null, address: null, total: 1 },
    ]);
    const loaded = await store.load({ aggregateType: "customer", aggregateId: "c-1" });
    expect(loaded.opened).toEqual([]);
  });

  it("reads what was sealed under a key the person no longer has as null, next to what their new key opens", async () => {
    const { storage, store, registered } = await setup();
    await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [registered(1, "ana@example.com")],
    });
    await removeKeys(storage.personalKeys, "c-1");
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
    const again = await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(loaded.opened).toEqual([{ person: "c-1", fingerprint: again?.fingerprint }]);
  });

  it("seals a person the events were decided on only under the key they were read under", async () => {
    const { storage, store, calls, registered } = await setup();
    await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [registered(1, "ana@example.com")],
    });
    const { opened = [] } = await store.load({ aggregateType: "customer", aggregateId: "c-1" });
    const other = await newStoredKey();
    await storage.personalKeys.add("c-2", DEFAULT_PERSONAL_CATEGORY, other);
    const read = [{ person: "c-2", fingerprint: other.fingerprint }, ...opened];
    const append = (version: number, persons: readonly KeyedPerson[]) =>
      store.append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: version - 1,
        events: [registered(version, "ana@example.com")],
        persons,
      });
    await append(2, read);
    await removeKeys(storage.personalKeys, "c-1");
    calls.length = 0;
    const refused = await append(3, read).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ForgottenSinceLoadError);
    expect(refused).toMatchObject({
      code: "CONCURRENCY_CONFLICT",
      streamId: "customer:c-1",
      expectedVersion: 2,
      actualVersion: 2,
      message: "Person c-1 was forgotten since customer:c-1 was loaded at version 2",
    });
    expect(calls).toEqual(["find:c-1"]);
    expect(await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY)).toBeNull();
    await append(3, [{ person: "c-1", fingerprint: null }]);
    const fresh = await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(fresh).not.toBeNull();
    expect(read.map(({ fingerprint }) => fingerprint)).not.toContain(fresh?.fingerprint);
    await expect(append(4, read)).rejects.toBeInstanceOf(ConcurrencyError);
    await append(4, [
      { person: "c-1", fingerprint: fresh?.fingerprint ?? null },
      ...read.slice(0, 1),
    ]);
    await removeKeys(storage.personalKeys, "c-1");
    await append(5, [{ person: "c-1", fingerprint: null }]);
    const renewed = await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(renewed?.fingerprint).not.toBe(fresh?.fingerprint);
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
    expect(calls).toEqual(["find:c-1"]);
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
    await storage.personalKeys.add("c-1", DEFAULT_PERSONAL_CATEGORY, await newStoredKey());
    const forgetting: PersonalKeyStore = {
      ...storage.personalKeys,
      get: async (person, category) => {
        const read = await storage.personalKeys.get(person, category);
        if (read !== null) await storage.personalKeys.remove(person, read.fingerprint);
        return read;
      },
    };
    const refused = await withPersonalData({
      eventStore: storage.eventStore,
      aggregates: buildAggregates({ registry, ports: {} }),
      processes: { byName: {} },
      keys: keysOver(forgetting),
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
      get: async (person, category) => {
        await storage.persons.restrict(person, {
          ground: "accuracy-contested",
          categories: null,
          since: new Date(),
        });
        return storage.personalKeys.get(person, category);
      },
    };
    const refused = await withPersonalData({
      eventStore: storage.eventStore,
      aggregates: buildAggregates({ registry, ports: {} }),
      processes: { byName: {} },
      keys: keysOver(restricting),
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
    await storage.persons.restrict("c-9", {
      ground: "accuracy-contested",
      categories: null,
      since: new Date(),
    });
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
      processes: { byName: {} },
      keys: keysOver(storage.personalKeys),
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
    const key = await storage.personalKeys.get("c-2", DEFAULT_PERSONAL_CATEGORY);
    expect(appended[0]?.persons).toEqual([read]);
    expect(appended[0]?.seals).toEqual([{ person: "c-2", fingerprint: key?.fingerprint }]);
    expect(appended[0]?.touches).toEqual(["c-4", "c-2"]);
    expect(appended[0]).not.toHaveProperty("basis");
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
    await recording.append({
      aggregateType: "order",
      aggregateId: "o-3",
      expectedVersion: 0,
      events: [placed({ customerId: "c-2", address: { street: "Main" }, total: 1 }, "o-3")],
      touches: ["c-4"],
      basis: "legal-claims",
    });
    expect(appended[2]).toMatchObject({
      persons: [{ person: "c-2", fingerprint: key?.fingerprint }],
      seals: [],
      touches: [],
    });
    await recording.append({
      aggregateType: "order",
      aggregateId: "o-4",
      expectedVersion: 0,
      events: [placed({ customerId: "c-2", address: { street: "Main" }, total: 1 }, "o-4")],
      basis: "legal-obligation",
    });
    expect(appended[3]).toMatchObject({
      persons: [],
      seals: [{ person: "c-2", fingerprint: key?.fingerprint }],
      touches: ["c-2"],
    });
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
      processes: { byName: {} },
      keys: keysOver(storage.personalKeys),
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
    const key = await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY);
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
    expect(retainedHidden(registered as StoredEvent)).toBeNull();
    expect(withoutRetained(registered as StoredEvent)).toBe(registered);
    // A key a forgetting kept: work that names no basis reads its field as null, upcast or not.
    await storage.personalKeys.retain("c-1", key?.fingerprint ?? "", {
      since: "2026-02-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });
    const [kept] = await store.readAll({ afterPosition: 0, limit: 1 });
    expect(kept?.payload).toEqual({ email: "ana@example.com", plan: "free" });
    expect(openedUnder(kept as StoredEvent)).toEqual([{ ...read[0], retained: true }]);
    const hidden = withoutRetained(kept as StoredEvent);
    expect(hidden.payload).toEqual({ email: null, plan: "free" });
    expect(hidden.metadata.schemaVersion).toBe(kept?.metadata.schemaVersion);
    expect(openedUnder(hidden)).toEqual([]);
    const loaded = await hidingRetained(store).load({
      aggregateType: "customer",
      aggregateId: "c-1",
    });
    expect(loaded.events.map((event) => event.payload)).toEqual([
      { email: null, plan: "free" },
      { name: "Ana" },
    ]);
    expect(loaded.opened).toEqual([]);
    expect((await store.load({ aggregateType: "customer", aggregateId: "c-1" })).opened).toEqual([
      { ...read[0], retained: true },
    ]);
    await removeKeys(storage.personalKeys, "c-1");
    const [forgotten] = await store.readAll({ afterPosition: 0, limit: 1 });
    expect(openedUnder(forgotten as StoredEvent)).toEqual([]);
  });

  it("hides what a forgetting kept in a process's state as in an event's payload", async () => {
    const storage = await memory().createStorage();
    const sealing = withPersonalData({
      eventStore: storage.eventStore,
      aggregates: buildAggregates({ registry, ports: {} }),
      processes: {
        byName: {
          "signup.onboarding": {
            personal: {
              person: "customerId",
              fields: ["email"],
              categories: { email: DEFAULT_PERSONAL_CATEGORY },
            },
          },
        } as never,
      },
      keys: keysOver(storage.personalKeys),
    });
    await sealing.append({
      aggregateType: "process:signup.onboarding",
      aggregateId: "s-1",
      expectedVersion: 0,
      events: [
        pendingEvent({
          aggregateType: "process:signup.onboarding",
          aggregateId: "s-1",
          version: 1,
          type: "ProcessStarted",
          payload: { state: { customerId: "c-1", email: "ana@example.com" } },
        }),
      ],
    });
    const key = await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY);
    await storage.personalKeys.retain("c-1", key?.fingerprint ?? "", {
      since: "2026-02-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });
    const [started] = await sealing.readAll({ afterPosition: 0, limit: 1 });
    expect(withoutRetained(started as StoredEvent).payload).toEqual({
      state: { customerId: "c-1", email: null },
    });
  });

  it("checks the keys an append is given to seal under as those it seals under itself", async () => {
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
      processes: { byName: {} },
      keys: keysOver(storage.personalKeys),
    });
    const given = { person: "c-9", fingerprint: "f-9" };
    await recording
      .append({
        aggregateType: "order",
        aggregateId: "o-1",
        expectedVersion: 0,
        events: [placed({ customerId: "c-2", total: 1 })].map((event) => ({
          ...event,
          payload: { customerId: "c-2", total: 1 },
        })),
        seals: [given],
      })
      .catch(() => undefined);
    expect(appended[0]?.seals).toEqual([given]);
  });

  it("keeps the key another writer added first", async () => {
    const { storage, store, registered } = await setup();
    const first = { key: "Zmlyc3Q=", fingerprint: "first", kid: null };
    await storage.personalKeys.add("c-1", DEFAULT_PERSONAL_CATEGORY, first);
    const concurrentKeys: PersonalKeyStore = { ...storage.personalKeys, get: async () => null };
    await expect(
      withPersonalData({
        eventStore: storage.eventStore,
        aggregates: buildAggregates({ registry, ports: {} }),
        processes: { byName: {} },
        keys: keysOver(concurrentKeys),
      }).append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: 0,
        events: [registered(1, "ana@example.com")],
      }),
    ).rejects.toThrow();
    expect(await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY)).toEqual(first);
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
    // Written as given: whoever reseals has sealed the payload already.
    await store.reseal([{ position: 2, payload: { as: "given" }, person: "c-9" }]);
    expect(
      await storage.eventStore.readByPerson({ person: "c-9", afterPosition: 0, limit: 1 }),
    ).toMatchObject([{ payload: { as: "given" } }]);
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
    await removeKeys(storage.personalKeys, "c-1");
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
    expect(
      (await storage.personalKeys.get("42", DEFAULT_PERSONAL_CATEGORY))?.fingerprint,
    ).toHaveLength(24);
  });

  it("seals the fields of each category under the person's key of that category, and forgets one category alone", async () => {
    const { storage, store } = await setup();
    const billed = { name: "Ana", iban: "ES00", email: "ana@example.com" };
    await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [
        pendingEvent({
          aggregateType: "customer",
          aggregateId: "c-1",
          version: 1,
          type: "CustomerBilled",
          payload: billed,
        }),
      ],
    });
    const [stored] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    const sealed = stored?.payload as Record<string, SealedValue>;
    const keyOf = async (category: string) =>
      (await storage.personalKeys.get("c-1", category))?.fingerprint;
    const [profile, invoices, plain] = await Promise.all(
      ["profile", "invoices", DEFAULT_PERSONAL_CATEGORY].map(keyOf),
    );
    expect(new Set([profile, invoices, plain]).size).toBe(3);
    expect(sealed.name?.$personal).toMatchObject({ category: "profile", key: profile });
    expect(sealed.iban?.$personal).toMatchObject({ category: "invoices", key: invoices });
    expect(sealed.email?.$personal).toMatchObject({ key: plain });
    expect(sealed.email?.$personal).not.toHaveProperty("category");

    const loaded = await store.load({ aggregateType: "customer", aggregateId: "c-1" });
    expect(loaded.events[0]?.payload).toEqual(billed);
    expect(loaded.opened).toHaveLength(3);
    expect(openedUnder(loaded.events[0] as StoredEvent)).toEqual(
      expect.arrayContaining([{ person: "c-1", fingerprint: invoices }]),
    );

    await storage.personalKeys.remove("c-1", invoices ?? "");
    const after = await store.load({ aggregateType: "customer", aggregateId: "c-1" });
    expect(after.events[0]?.payload).toEqual({ ...billed, iban: null });
    expect(after.opened?.map(({ fingerprint }) => fingerprint)).not.toContain(invoices);
  });

  it("opens what a key kept past a forgetting sealed, naming it retained, which the store checks as such", async () => {
    const { storage, store, registered } = await setup();
    await store.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [registered(1, "ana@example.com")],
    });
    const fingerprint =
      (await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY))?.fingerprint ?? "";
    await storage.personalKeys.retain("c-1", fingerprint, {
      since: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2025-12-01T00:00:00.000Z",
    });
    const loaded = await store.load({ aggregateType: "customer", aggregateId: "c-1" });
    expect(loaded.events[0]?.payload).toEqual({ email: "ana@example.com", plan: "pro" });
    expect(loaded.opened).toEqual([{ person: "c-1", fingerprint, retained: true }]);
    const append = (persons: readonly KeyedPerson[]) =>
      store.append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: 1,
        events: [registered(2, "ana@again.example")],
        persons,
      });
    await expect(append([{ person: "c-1", fingerprint }])).rejects.toBeInstanceOf(
      ForgottenSinceLoadError,
    );
    await append(loaded.opened ?? []);
    const again = await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(again?.fingerprint).not.toBe(fingerprint);
    expect(
      (await store.load({ aggregateType: "customer", aggregateId: "c-1" })).events.map(
        (event) => (event.payload as { email: unknown }).email,
      ),
    ).toEqual(["ana@example.com", "ana@again.example"]);
  });
});

describe("withPersonalData on a process's lifecycle events", () => {
  const processes = {
    byName: {
      "signup.onboarding": {
        personal: {
          person: "customerId",
          fields: ["email"],
          categories: { email: DEFAULT_PERSONAL_CATEGORY },
        },
      },
      "signup.plain": { personal: null },
    },
  } as unknown as Pick<ProcessesRuntime, "byName">;
  const stream = { aggregateType: "process:signup.onboarding", aggregateId: "s-1" };

  const lifecycleSetup = async () => {
    const storage = await memory().createStorage();
    const store = withPersonalData({
      eventStore: storage.eventStore,
      aggregates: buildAggregates({ registry, ports: {} }),
      processes,
      keys: keysOver(storage.personalKeys),
    });
    const lifecycle = (
      version: number,
      type: string,
      payload: object,
      aggregateType = stream.aggregateType,
    ) => pendingEvent({ aggregateType, aggregateId: "s-1", version, type, payload });
    const append = (events: ReturnType<typeof lifecycle>[], args: Partial<AppendArgs> = {}) =>
      store.append({
        aggregateType: events[0]?.aggregateType ?? stream.aggregateType,
        aggregateId: "s-1",
        expectedVersion: (events[0]?.version ?? 1) - 1,
        events,
        ...args,
      });
    return { storage, store, lifecycle, append };
  };

  it("seals the state's personal fields under whom it names, and opens them on every read", async () => {
    const { storage, store, lifecycle, append } = await lifecycleSetup();
    const state = { customerId: "c-1", email: "ana@example.com", nudges: 1 };
    await append([lifecycle(1, "ProcessHandled", { state, eventId: "e-1" })]);

    const [stored] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    const sealed = (stored?.payload as { state: Record<string, unknown> } | undefined)?.state ?? {};
    expect(isSealed(sealed.email)).toBe(true);
    expect(sealed.customerId).toBe("c-1");
    expect(stored?.person).toBe("c-1");
    expect(JSON.stringify(stored)).not.toContain("ana@example.com");

    const fingerprint = (await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY))
      ?.fingerprint;
    const loaded = await store.load(stream);
    expect(loaded.events[0]?.payload).toEqual({ state, eventId: "e-1" });
    expect(loaded.opened).toEqual([{ person: "c-1", fingerprint }]);
    expect(openedUnder(loaded.events[0] as StoredEvent)).toEqual([{ person: "c-1", fingerprint }]);
    const [byPerson] = await store.readByPerson({ person: "c-1", afterPosition: 0, limit: 10 });
    expect(byPerson?.payload).toEqual({ state, eventId: "e-1" });

    await removeKeys(storage.personalKeys, "c-1");
    expect((await store.load(stream)).events[0]?.payload).toEqual({
      state: { ...state, email: null },
      eventId: "e-1",
    });
  });

  it("leaves alone what names nobody: no state, a state with no person yet, a process that marks nothing or is gone", async () => {
    const { storage, store, lifecycle, append } = await lifecycleSetup();
    await append([
      lifecycle(1, "ProcessStarted", { state: { customerId: null, email: null }, eventId: "e-1" }),
      lifecycle(2, "ProcessCompleted", { eventId: "e-2" }),
    ]);
    await append([
      lifecycle(1, "ProcessStarted", { state: { email: "a@b.c" } }, "process:signup.plain"),
    ]);
    await append([
      lifecycle(1, "ProcessStarted", { state: { email: "a@b.c" } }, "process:signup.gone"),
    ]);

    const stored = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(stored.map((event) => [event.person, event.payload])).toEqual([
      [null, { state: { customerId: null, email: null }, eventId: "e-1" }],
      [null, { eventId: "e-2" }],
      [null, { state: { email: "a@b.c" } }],
      [null, { state: { email: "a@b.c" } }],
    ]);
    expect(await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY)).toBeNull();
    expect(await store.readAll({ afterPosition: 0, limit: 10 })).toEqual(stored);
  });

  it("refuses an envelope in a state, whatever its process marks", async () => {
    const { lifecycle, append } = await lifecycleSetup();
    const envelope = { $personal: { person: "c-1", key: "k", iv: "i", data: "d" } };
    for (const aggregateType of [stream.aggregateType, "process:signup.plain"]) {
      await expect(
        append([
          lifecycle(
            1,
            "ProcessHandled",
            { state: { customerId: "c-1", note: envelope } },
            aggregateType,
          ),
        ]),
      ).rejects.toThrow(
        `State of process ${aggregateType.slice("process:".length)} for s-1 carries a sealed value in "note": personal fields are sealed by the runtime, never by a handler`,
      );
    }
  });

  it("refuses a personal value with nobody named, and appends while its person is restricted never", async () => {
    const { storage, lifecycle, append } = await lifecycleSetup();
    await expect(
      append([lifecycle(1, "ProcessHandled", { state: { customerId: null, email: "a@b.c" } })]),
    ).rejects.toThrow(ValidationError);

    await storage.persons.restrict("c-1", {
      ground: "accuracy-contested",
      categories: null,
      since: new Date(0),
    });
    await expect(
      append([lifecycle(1, "ProcessHandled", { state: { customerId: "c-1", email: null } })]),
    ).rejects.toThrow(ProcessingRestrictedError);
  });

  it("refuses to seal anew under a key other than the one the instance was loaded under", async () => {
    const { storage, lifecycle, append } = await lifecycleSetup();
    const state = { customerId: "c-1", email: "ana@example.com" };
    await append([lifecycle(1, "ProcessHandled", { state })]);
    const fingerprint =
      (await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY))?.fingerprint ?? null;
    await removeKeys(storage.personalKeys, "c-1");

    await expect(
      append([lifecycle(2, "ProcessHandled", { state })], {
        persons: [{ person: "c-1", fingerprint }],
      }),
    ).rejects.toThrow(ForgottenSinceLoadError);
  });
});
