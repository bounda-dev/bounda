import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { NewDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import type { PendingEvent } from "../../adapter/storage/event-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { memory } from "../../memory/index.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../../modules/bounda-events.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { generatePersonalKey, importPersonalKey, isSealed, unseal } from "./crypto.ts";
import { createResealBatches } from "./reseal-batches.ts";
import { createPersonalKeyWrapping } from "./wrapped-keys.ts";

const metadata = {
  correlationId: "c",
  causationId: "c",
  commandId: "c",
  depth: 0,
  schemaVersion: 1,
  system: false,
};

const customer = { name: "customer", snapshot: { every: 1, verify: 0, fingerprint: "f" } };
const order = { name: "order", snapshot: null };

const aggregates = {
  byName: {
    customer: {
      ...customer,
      eventsByType: {
        CustomerRegistered: { personal: { person: null, fields: ["email"] } },
      },
    },
    order: {
      ...order,
      eventsByType: {
        OrderPlaced: { personal: { person: "customerId", fields: ["address"] } },
      },
    },
  },
  commandsByType: {
    RemindCustomer: { command: { personal: { person: null, fields: ["email"] } } },
    ShipOrder: { command: { personal: { person: "customerId", fields: ["address"] } } },
  },
} as unknown as AggregatesRuntime;

const processes = { byName: {} } as unknown as Pick<ProcessesRuntime, "byName">;

const event = (
  aggregateType: string,
  aggregateId: string,
  version: number,
  type: string,
  payload: unknown,
): PendingEvent => ({
  id: `${aggregateType}-${aggregateId}-${version}`,
  aggregateType,
  aggregateId,
  version,
  type,
  payload,
  timestamp: `2026-01-0${version}T00:00:00.000Z`,
  metadata,
  person: null,
});

const forgotten = (person: string, version = 1): PendingEvent => ({
  ...event(BOUNDA_AGGREGATE, person, version, PERSONAL_DATA_FORGOTTEN_EVENT, { personId: person }),
  timestamp: "2026-01-05T00:00:00.000Z",
  metadata: { ...metadata, system: true },
  person,
});

const setup = async (recordsActivity = true) => {
  const storage: Storage = await memory().createStorage();
  const wrapping = createPersonalKeyWrapping({ wrapper: null, clock: createFixedClock() });
  const reseal = createResealBatches({
    storage,
    aggregates,
    processes,
    wrapping,
    recordsActivity,
  });
  const append = async (...events: PendingEvent[]) => {
    for (const pending of events) {
      const { version } = await storage.eventStore.load({
        aggregateType: pending.aggregateType,
        aggregateId: pending.aggregateId,
      });
      await storage.eventStore.append({
        aggregateType: pending.aggregateType,
        aggregateId: pending.aggregateId,
        expectedVersion: version,
        events: [{ ...pending, version: version + 1 }],
      });
    }
  };
  const opened = async (person: string, value: unknown) => {
    const stored = await storage.personalKeys.get(person);
    const key = stored === null ? null : await importPersonalKey(stored);
    return unseal({ key, sealed: value as never });
  };
  return { storage, reseal, append, opened };
};

const fieldOf = (value: unknown, name: string): unknown =>
  (value as Readonly<Record<string, unknown>> | undefined)?.[name];

const all = (storage: Storage) => storage.eventStore.readAll({ afterPosition: 0, limit: 100 });

describe("resealing a batch of events", () => {
  it("seals each one under its person, discarding a key for a person forgotten after it, and counts what names nobody", async () => {
    const { storage, reseal, append, opened } = await setup();
    await append(
      event("customer", "c-1", 1, "CustomerRegistered", { email: "ada@example.com" }),
      event("customer", "c-2", 1, "CustomerRegistered", { email: "bob@example.com" }),
      event("order", "o-1", 1, "OrderPlaced", { customerId: "c-1", address: "Bilbao" }),
      event("order", "o-2", 1, "OrderPlaced", { customerId: "", address: "Getxo" }),
      forgotten("c-2"),
    );
    await storage.snapshotStore.put({
      aggregateType: "customer",
      aggregateId: "c-1",
      version: 1,
      fingerprint: "f",
      state: "{}",
      persons: [],
    });
    const sealed = await reseal.events(await all(storage));

    expect(sealed).toEqual({
      resealed: 3,
      discarded: 1,
      unsealable: 1,
      discardedTypes: new Set(["customer.CustomerRegistered"]),
      unsealableTypes: new Set(["order.OrderPlaced"]),
    });
    const [ada, bob, placed, nameless] = await all(storage);
    expect([ada?.person, bob?.person, placed?.person, nameless?.person]).toEqual([
      "c-1",
      "c-2",
      "c-1",
      null,
    ]);
    expect(await opened("c-1", fieldOf(ada?.payload, "email"))).toBe("ada@example.com");
    expect(await opened("c-1", fieldOf(placed?.payload, "address"))).toBe("Bilbao");
    expect(isSealed(fieldOf(bob?.payload, "email"))).toBe(true);
    expect(await storage.personalKeys.get("c-2")).toBeNull();
    expect(nameless?.payload).toEqual({ customerId: "", address: "Getxo" });
    expect(
      await storage.snapshotStore.get({ aggregateType: "customer", aggregateId: "c-1" }),
    ).toBeNull();
    expect(await storage.persons.get("c-1")).toMatchObject({
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await reseal.events(await all(storage))).toEqual({
      resealed: 0,
      discarded: 0,
      unsealable: 1,
      discardedTypes: new Set(),
      unsealableTypes: new Set(["order.OrderPlaced"]),
    });
  });

  it("drops only the snapshots of aggregates that take them, and records no activity without a retention, nor for an event that named its person", async () => {
    const { storage, reseal, append } = await setup(false);
    await append(event("order", "o-1", 1, "OrderPlaced", { customerId: "c-1", address: "Bilbao" }));
    const snapshot = {
      aggregateType: "order",
      aggregateId: "o-1",
      version: 1,
      fingerprint: "f",
      state: "{}",
      persons: [],
    };
    await storage.snapshotStore.put(snapshot);
    await reseal.events(await all(storage));
    expect(await storage.snapshotStore.get(snapshot)).toEqual(snapshot);
    expect(await storage.persons.get("c-1")).toBeNull();

    const retained = await setup(true);
    await retained.append({
      ...event("customer", "c-1", 1, "CustomerRegistered", { email: "a" }),
      person: "c-1",
    });
    await retained.reseal.events(await all(retained.storage));
    expect(await retained.storage.persons.get("c-1")).toBeNull();
  });
});

describe("resealing scheduled commands", () => {
  it("seals each payload under its person, keeping the persons it named, and counts what names nobody", async () => {
    const { storage, reseal, append, opened } = await setup();
    const old = await importPersonalKey(await generatePersonalKey());
    await append(forgotten("c-9"));
    const schedule = (dedupeKey: string, type: string, aggregateId: string, payload: unknown) =>
      storage.scheduler.schedule({
        dedupeKey,
        command: { type, aggregateId, payload },
        executeAt: new Date("2026-02-01T00:00:00.000Z"),
        context: { correlationId: "c", causationId: "c", depth: 0 },
        ...(dedupeKey === "a"
          ? { persons: [{ person: "c-1", fingerprint: old.fingerprint }] }
          : {}),
      });
    await schedule("a", "RemindCustomer", "c-1", { email: "ada@example.com" });
    await schedule("b", "ShipOrder", "o-1", { customerId: "", address: "Bilbao" });
    await schedule("c", "RemindCustomer", "c-9", { email: "gone@example.com" });
    await schedule("d", "Unmarked", "x", { email: "x@example.com" });

    expect(await reseal.commands(await storage.scheduler.list())).toEqual({
      resealed: 2,
      discarded: 1,
      unsealable: 1,
      discardedTypes: new Set(),
      unsealableTypes: new Set(["ShipOrder"]),
    });
    const [a, b, c, d] = await storage.scheduler.list();
    const key = await storage.personalKeys.get("c-1");
    expect(a?.persons).toEqual([
      { person: "c-1", fingerprint: old.fingerprint },
      { person: "c-1", fingerprint: key?.fingerprint },
    ]);
    expect(await opened("c-1", fieldOf(a?.command.payload, "email"))).toBe("ada@example.com");
    expect(b?.command.payload).toEqual({ customerId: "", address: "Bilbao" });
    expect(c?.persons).toHaveLength(1);
    expect(await storage.personalKeys.get("c-9")).toBeNull();
    expect(d?.command.payload).toEqual({ email: "x@example.com" });
  });
});

describe("resealing dead letters", () => {
  const letter = (id: string, overrides: Partial<NewDeadLetter> = {}): NewDeadLetter => ({
    id,
    kind: "policy",
    handler: "customer.greet",
    eventId: "customer-c-1-1",
    eventType: "CustomerRegistered",
    aggregateType: "customer",
    aggregateId: "c-1",
    person: null,
    errorType: "terminal",
    errorName: "Error",
    errorMessage: "cannot greet ada@example.com",
    errorStack: "Error: cannot greet ada@example.com\n    at greet",
    attempts: 1,
    firstFailedAt: "2026-01-02T00:00:00.000Z",
    lastFailedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  });

  const started = Date.parse("2026-01-03T00:00:00.000Z");

  it("seals what a letter filed before the marks holds of the person its work names now", async () => {
    const { storage, reseal, append, opened } = await setup();
    await append(
      event("customer", "c-1", 1, "CustomerRegistered", { email: "ada@example.com" }),
      event("customer", "c-3", 1, "CustomerRegistered", {}),
    );
    await storage.personalKeys.add("c-1", await generatePersonalKey());
    await storage.deadLetterStore.add(letter("policy"));
    await storage.deadLetterStore.add(
      letter("scheduled", {
        kind: "scheduled",
        handler: "RemindCustomer",
        eventId: "command:r",
        payload: { email: "ada@example.com" },
      }),
    );
    await storage.deadLetterStore.add(
      letter("since", { lastFailedAt: "2026-01-04T00:00:00.000Z" }),
    );
    await storage.deadLetterStore.add(
      letter("nobody", { eventId: "customer-c-3-1", aggregateId: "c-3" }),
    );
    await storage.deadLetterStore.add(letter("missing", { eventId: "gone" }));
    await storage.deadLetterStore.add(letter("named", { person: "c-1" }));
    await storage.deadLetterStore.add(
      letter("nameless", {
        kind: "scheduled",
        handler: "ShipOrder",
        aggregateId: "o-1",
        payload: { customerId: "", address: "Bilbao" },
      }),
    );

    expect(await reseal.letters(await storage.deadLetterStore.list(), started)).toEqual({
      resealed: 2,
      discarded: 0,
      unsealable: 1,
      discardedTypes: new Set(),
      unsealableTypes: new Set(["ShipOrder"]),
    });
    const policy = await storage.deadLetterStore.get("policy");
    expect(policy?.person).toBe("c-1");
    expect(await opened("c-1", policy?.errorMessage)).toBe("cannot greet ada@example.com");
    expect(await opened("c-1", policy?.errorStack)).toContain("at greet");
    expect(policy).not.toHaveProperty("payload");
    expect(policy).not.toHaveProperty("persons");
    const scheduled = await storage.deadLetterStore.get("scheduled");
    const key = await storage.personalKeys.get("c-1");
    expect(scheduled).toMatchObject({
      person: "c-1",
      persons: [{ person: "c-1", fingerprint: key?.fingerprint }],
    });
    expect(await opened("c-1", fieldOf(scheduled?.payload, "email"))).toBe("ada@example.com");
    expect(await opened("c-1", scheduled?.errorMessage)).toBe("cannot greet ada@example.com");
    for (const id of ["since", "nobody", "missing", "named", "nameless"]) {
      expect(await storage.deadLetterStore.get(id)).toMatchObject({
        errorMessage: "cannot greet ada@example.com",
      });
    }
    expect((await storage.deadLetterStore.get("nameless"))?.payload).toEqual({
      customerId: "",
      address: "Bilbao",
    });
  });

  it("seals the text of a person forgotten after it failed, or without a key, under a key nobody keeps", async () => {
    const { storage, reseal, append } = await setup();
    await append(
      event("customer", "c-1", 1, "CustomerRegistered", { email: "ada@example.com" }),
      forgotten("c-1"),
    );
    await storage.deadLetterStore.add(letter("policy", { errorStack: undefined }));
    await storage.deadLetterStore.add(
      letter("scheduled", {
        kind: "scheduled",
        handler: "RemindCustomer",
        eventId: "command:r",
        payload: { email: "ada@example.com" },
      }),
    );
    expect(await reseal.letters(await storage.deadLetterStore.list(), started)).toMatchObject({
      resealed: 2,
      discarded: 2,
    });
    expect(await storage.personalKeys.get("c-1")).toBeNull();
    const policy = await storage.deadLetterStore.get("policy");
    expect(isSealed(policy?.errorMessage)).toBe(true);
    expect(policy).not.toHaveProperty("errorStack");
  });
});
