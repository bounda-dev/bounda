import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { NewDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import type { PendingEvent } from "../../adapter/storage/event-store.ts";
import type { KeyedPerson, SealedValue } from "../../adapter/storage/personal-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../../modules/bounda-events.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { processAggregateType } from "../process/lifecycle.ts";
import { keysOver, newStoredKey, openedKey, testWrapping } from "../test-support.ts";
import { type AtRestSealer, createAtRestSealer } from "./at-rest.ts";
import { sealedKeys } from "./commands.ts";
import { isSealed, seal, unseal } from "./crypto.ts";
import { openTextWith } from "./errors.ts";
import { createResealBatches } from "./reseal-batches.ts";

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
        CustomerRegistered: { personal: { person: null, fields: ["email"], categories: {} } },
        CustomerProfiled: {
          personal: {
            person: null,
            fields: ["email", "nickname"],
            categories: { nickname: "profile" },
          },
        },
      },
    },
    order: {
      ...order,
      eventsByType: {
        OrderPlaced: { personal: { person: "customerId", fields: ["address"], categories: {} } },
      },
    },
  },
  commandsByType: {
    RemindCustomer: { command: { personal: { person: null, fields: ["email"], categories: {} } } },
    NameCustomer: {
      command: {
        personal: { person: null, fields: ["nickname"], categories: { nickname: "profile" } },
      },
    },
    ShipOrder: {
      command: { personal: { person: "customerId", fields: ["address"], categories: {} } },
    },
  },
} as unknown as AggregatesRuntime;

const processes = {
  byName: {
    "signup.onboarding": { personal: { person: "customerId", fields: ["email"], categories: {} } },
  },
} as unknown as Pick<ProcessesRuntime, "byName">;

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

const forgotten = (person: string, version = 1, payload: object = {}): PendingEvent => ({
  ...event(BOUNDA_AGGREGATE, person, version, PERSONAL_DATA_FORGOTTEN_EVENT, {
    personId: person,
    ...payload,
  }),
  timestamp: "2026-01-05T00:00:00.000Z",
  metadata: { ...metadata, system: true },
  person,
});

const setup = async (recordsActivity = true, atRest: AtRestSealer | null = null) => {
  const storage: Storage = await memory().createStorage();
  const wrapping = testWrapping();
  const reseal = createResealBatches({
    storage,
    reading: storage.eventStore,
    aggregates,
    processes,
    wrapping,
    atRest,
    marks: "m1",
    logger: silentLogger,
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
  // Opens a value sealed under one key or several, one inside the other.
  const opened = async (value: unknown): Promise<unknown> => {
    let current = value;
    while (isSealed(current)) {
      const { person, key: fingerprint } = (current as SealedValue).$personal;
      const found = await storage.personalKeys.find(person, fingerprint);
      const key = found === null ? null : await openedKey(found.key);
      current = await unseal({ key, sealed: current as SealedValue });
    }
    return current;
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
    const sealed = await reseal.events(await all(storage), true);

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
    expect(await opened(fieldOf(ada?.payload, "email"))).toBe("ada@example.com");
    expect(await opened(fieldOf(placed?.payload, "address"))).toBe("Bilbao");
    expect(isSealed(fieldOf(bob?.payload, "email"))).toBe(true);
    expect(await storage.personalKeys.get("c-2", "default")).toBeNull();
    expect(nameless?.payload).toEqual({ customerId: "", address: "Getxo" });
    expect(
      await storage.snapshotStore.get({ aggregateType: "customer", aggregateId: "c-1" }),
    ).toBeNull();
    expect(await storage.persons.get("c-1")).toMatchObject({
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await reseal.events(await all(storage), true)).toEqual({
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
    await reseal.events(await all(storage), true);
    expect(await storage.snapshotStore.get(snapshot)).toEqual(snapshot);
    expect(await storage.persons.get("c-1")).toBeNull();

    const retained = await setup(true);
    await retained.append({
      ...event("customer", "c-1", 1, "CustomerRegistered", { email: "a" }),
      person: "c-1",
    });
    await retained.reseal.events(await all(retained.storage), true);
    expect(await retained.storage.persons.get("c-1")).toBeNull();
  });
});

describe("resealing a batch of events by category", () => {
  it("seals each field under its category's key, discarding only the key of a category forgotten after it", async () => {
    const { storage, reseal, append, opened } = await setup();
    await append(
      event("customer", "c-1", 1, "CustomerProfiled", {
        email: "ada@example.com",
        nickname: "Ada",
      }),
      forgotten("c-1", 1, { whole: false, categories: ["profile"], retained: [], expired: [] }),
    );
    expect(await reseal.events(await all(storage), true)).toEqual({
      resealed: 1,
      discarded: 1,
      unsealable: 0,
      discardedTypes: new Set(["customer.CustomerProfiled"]),
      unsealableTypes: new Set(),
    });
    const [profiled] = await all(storage);
    expect(await opened(fieldOf(profiled?.payload, "email"))).toBe("ada@example.com");
    expect(fieldOf(profiled?.payload, "nickname")).toMatchObject({
      $personal: { category: "profile" },
    });
    expect(await opened(fieldOf(profiled?.payload, "nickname"))).toBeNull();
    expect((await storage.personalKeys.list("c-1")).map(({ category }) => category)).toEqual([
      "default",
    ]);
  });
});

describe("resealing a field moved to another category", () => {
  it("seals it anew under its category's key", async () => {
    const { storage, reseal, append, opened } = await setup();
    const stored = await storage.personalKeys.add("c-1", "default", await newStoredKey());
    const old = await openedKey(stored);
    const nickname = await seal({ key: old, person: "c-1", category: "default", value: "Ada" });
    await append(
      event("customer", "c-1", 1, "CustomerProfiled", { email: "ada@example.com", nickname }),
    );
    expect((await reseal.events(await all(storage), true)).resealed).toBe(1);
    const [profiled] = await all(storage);
    expect(fieldOf(profiled?.payload, "nickname")).toMatchObject({
      $personal: { category: "profile" },
    });
    expect(await opened(fieldOf(profiled?.payload, "nickname"))).toBe("Ada");
  });

  it("names a resealed command's person under the key it moved to, keeping who else it named", async () => {
    const { storage, reseal, opened } = await setup();
    const stored = await storage.personalKeys.add("c-1", "default", await newStoredKey());
    const nickname = await seal({
      key: await openedKey(stored),
      person: "c-1",
      category: "default",
      value: "Ada",
    });
    await storage.scheduler.schedule({
      dedupeKey: "a",
      command: { type: "NameCustomer", aggregateId: "c-1", payload: { nickname } },
      executeAt: new Date("2026-02-01T00:00:00.000Z"),
      scheduledAt: new Date("2026-02-01T00:00:00.000Z"),
      context: { correlationId: "c", causationId: "c", depth: 0 },
      persons: [
        { person: "c-1", fingerprint: stored.fingerprint },
        { person: "c-2", fingerprint: "f-other" },
        { person: "c-1", fingerprint: null },
      ],
    });
    expect((await reseal.commands(await storage.scheduler.list())).resealed).toBe(1);
    const [entry] = await storage.scheduler.list();
    const profile = await storage.personalKeys.get("c-1", "profile");
    expect(entry?.persons).toEqual([
      { person: "c-2", fingerprint: "f-other" },
      { person: "c-1", fingerprint: null },
      { person: "c-1", fingerprint: profile?.fingerprint },
    ]);
    expect(await opened(fieldOf(entry?.command.payload, "nickname"))).toBe("Ada");
  });

  it("leaves a value no key opens any more as it is", async () => {
    const { storage, reseal, append } = await setup();
    const gone = await openedKey(await newStoredKey());
    const nickname = await seal({ key: gone, person: "c-1", category: "default", value: "Ada" });
    await append(
      event("customer", "c-1", 1, "CustomerProfiled", { email: "ada@example.com", nickname }),
    );
    await reseal.events(await all(storage), true);
    const [profiled] = await all(storage);
    expect(fieldOf(profiled?.payload, "nickname")).toEqual(nickname);
    expect((await storage.personalKeys.list("c-1")).map(({ category }) => category)).toEqual([
      "default",
    ]);
  });
});

describe("resealing a process's lifecycle events", () => {
  it("seals their state under whom it names, with no snapshot to drop", async () => {
    const { storage, reseal, append, opened } = await setup();
    await append(
      event("process:signup.onboarding", "s-1", 1, "ProcessHandled", {
        step: "x",
        state: { customerId: "c-1", email: "ada@example.com" },
      }),
    );
    expect(await reseal.events(await all(storage), true)).toMatchObject({ resealed: 1 });
    const [handled] = await all(storage);
    expect(handled?.person).toBe("c-1");
    expect(await opened(fieldOf(fieldOf(handled?.payload, "state"), "email"))).toBe(
      "ada@example.com",
    );
  });
});

describe("resealing scheduled commands", () => {
  it("seals each payload under its person, keeping the persons it named, and counts what names nobody", async () => {
    const { storage, reseal, append, opened } = await setup();
    const old = await openedKey(await newStoredKey());
    await append(forgotten("c-9"));
    const schedule = (dedupeKey: string, type: string, aggregateId: string, payload: unknown) =>
      storage.scheduler.schedule({
        dedupeKey,
        command: { type, aggregateId, payload },
        executeAt: new Date("2026-02-01T00:00:00.000Z"),
        scheduledAt: new Date("2026-02-01T00:00:00.000Z"),
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
    const key = await storage.personalKeys.get("c-1", "default");
    expect(a?.persons).toEqual([
      { person: "c-1", fingerprint: old.fingerprint },
      { person: "c-1", fingerprint: key?.fingerprint },
    ]);
    expect(await opened(fieldOf(a?.command.payload, "email"))).toBe("ada@example.com");
    expect(b?.command.payload).toEqual({ customerId: "", address: "Bilbao" });
    expect(c?.persons).toHaveLength(1);
    expect(await storage.personalKeys.get("c-9", "default")).toBeNull();
    expect(d?.command.payload).toEqual({ email: "x@example.com" });
  });

  it("seals a payload under the key the person holds when it was scheduled after their last forgetting, and under none before", async () => {
    const { storage, reseal, append } = await setup();
    await append(forgotten("c-1"));
    const held = await storage.personalKeys.add("c-1", "default", await newStoredKey());
    const schedule = (dedupeKey: string, scheduledAt: string) =>
      storage.scheduler.schedule({
        dedupeKey,
        command: { type: "RemindCustomer", aggregateId: "c-1", payload: { email: "ada@x.com" } },
        executeAt: new Date("2026-02-01T00:00:00.000Z"),
        scheduledAt: new Date(scheduledAt),
        context: { correlationId: "c", causationId: "c", depth: 0 },
      });
    await schedule("after", "2026-01-06T00:00:00.000Z");
    await schedule("before", "2026-01-04T00:00:00.000Z");
    expect((await reseal.commands(await storage.scheduler.list())).discarded).toBe(1);
    const keyOf = async (dedupeKey: string) =>
      (fieldOf((await storage.scheduler.get(dedupeKey))?.command.payload, "email") as SealedValue)
        .$personal.key;
    expect(await keyOf("after")).toBe(held.fingerprint);
    expect(await keyOf("before")).not.toBe(held.fingerprint);
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
    await storage.personalKeys.add("c-1", "default", await newStoredKey());
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
    expect(await opened(policy?.errorMessage)).toBe("cannot greet ada@example.com");
    expect(await opened(policy?.errorStack)).toContain("at greet");
    expect(policy).not.toHaveProperty("payload");
    expect(policy).not.toHaveProperty("persons");
    const scheduled = await storage.deadLetterStore.get("scheduled");
    const key = await storage.personalKeys.get("c-1", "default");
    expect(scheduled).toMatchObject({
      person: "c-1",
      persons: [{ person: "c-1", fingerprint: key?.fingerprint }],
    });
    expect(await opened(fieldOf(scheduled?.payload, "email"))).toBe("ada@example.com");
    expect(await opened(scheduled?.errorMessage)).toBe("cannot greet ada@example.com");
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
    const { errorStack: _stack, ...stackless } = letter("policy");
    await storage.deadLetterStore.add(stackless);
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
    expect(await storage.personalKeys.get("c-1", "default")).toBeNull();
    const policy = await storage.deadLetterStore.get("policy");
    expect(isSealed(policy?.errorMessage)).toBe(true);
    expect(policy).not.toHaveProperty("errorStack");
  });

  it("seals the text of a letter under every key the person holds, one inside the other", async () => {
    const { storage, reseal, append, opened } = await setup();
    await append(event("customer", "c-1", 1, "CustomerRegistered", { email: "ada@example.com" }));
    await storage.personalKeys.add("c-1", "default", await newStoredKey());
    const profile = await storage.personalKeys.add("c-1", "profile", await newStoredKey());
    await storage.deadLetterStore.add(letter("policy"));
    await reseal.letters(await storage.deadLetterStore.list(), started);
    const policy = await storage.deadLetterStore.get("policy");
    expect(policy?.errorMessage).toMatchObject({
      $personal: { person: "c-1", category: "profile", key: profile.fingerprint },
    });
    expect(await opened(policy?.errorMessage)).toBe("cannot greet ada@example.com");
    await storage.personalKeys.remove("c-1", profile.fingerprint);
    expect(await opened(policy?.errorMessage)).toBeNull();
  });

  it("seals the payload of a letter that names its person already, leaving its text as it is", async () => {
    const { storage, reseal, opened } = await setup();
    const key = await storage.personalKeys.add("c-1", "default", await newStoredKey());
    const sealedText = { $personal: { person: "c-1", key: key.fingerprint, iv: "iv", data: "d" } };
    await storage.deadLetterStore.add(
      letter("scheduled", {
        kind: "scheduled",
        handler: "RemindCustomer",
        eventId: "command:r",
        person: "c-1",
        errorMessage: sealedText,
        errorStack: sealedText,
        payload: { email: "ada@example.com" },
      }),
    );
    await storage.deadLetterStore.add(
      letter("unmarked", {
        kind: "scheduled",
        handler: "Unmarked",
        eventId: "command:u",
        payload: { email: "ada@example.com" },
      }),
    );
    expect(await reseal.letters(await storage.deadLetterStore.list(), started)).toMatchObject({
      resealed: 1,
    });
    const resealed = await storage.deadLetterStore.get("scheduled");
    expect(resealed).toMatchObject({
      person: "c-1",
      errorMessage: sealedText,
      errorStack: sealedText,
    });
    expect(await opened(fieldOf(resealed?.payload, "email"))).toBe("ada@example.com");
    expect((await storage.deadLetterStore.get("unmarked"))?.payload).toEqual({
      email: "ada@example.com",
    });
  });

  it("counts a letter discarded when its payload is, though its text opens under the key the person holds again", async () => {
    const { storage, reseal, append, opened } = await setup();
    await append(forgotten("c-1"));
    await storage.personalKeys.add("c-1", "default", await newStoredKey());
    await storage.deadLetterStore.add(
      letter("scheduled", {
        kind: "scheduled",
        handler: "RemindCustomer",
        eventId: "command:r",
        payload: { email: "ada@example.com" },
        firstFailedAt: "2026-01-01T00:00:00.000Z",
        lastFailedAt: "2026-01-09T00:00:00.000Z",
      }),
    );
    expect(await reseal.letters(await storage.deadLetterStore.list(), started)).toMatchObject({
      resealed: 1,
      discarded: 1,
    });
    const resealed = await storage.deadLetterStore.get("scheduled");
    expect(await opened(fieldOf(resealed?.payload, "email"))).toBeNull();
    expect(await opened(resealed?.errorMessage)).toBe("cannot greet ada@example.com");
  });
});

describe("resealing remembered answers", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const outcome = { rejected: "Taken", message: "Ada is taken" };
  const base = () =>
    crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "HKDF", false, [
      "deriveKey",
    ]);

  it("erases those sealed under other marks, or under none, or no key opens, and files one kept in the clear under its HMAC", async () => {
    const atRest = createAtRestSealer(await base());
    const { storage, reseal } = await setup(true, atRest);
    const stored = await storage.personalKeys.add("c-1", "default", await newStoredKey());
    const key = await openedKey(stored);
    const remembered = (marks?: string | null) => ({
      key: "k",
      fingerprint: "fp",
      outcome,
      ...(marks === undefined ? {} : { marks }),
    });
    const put = (key: string, answer: object, persons: readonly KeyedPerson[] = []) =>
      storage.idempotencyStore.put({
        key,
        answer,
        expiresAt: "2099-01-01T00:00:00.000Z",
        persons,
        now,
      });
    const named = [{ person: "c-1", fingerprint: stored.fingerprint }] as const;
    await put(
      "current",
      await seal({ key, person: "c-1", category: "default", value: remembered("m1") }),
      named,
    );
    await put(
      "other",
      await seal({ key, person: "c-1", category: "default", value: remembered("m0") }),
      named,
    );
    await put("unmarked", await atRest.seal(JSON.stringify(remembered())));
    await put("nobody", await atRest.seal(JSON.stringify(remembered("m1"))));
    await put(
      "gone",
      await seal({
        key: await openedKey(await newStoredKey()),
        person: "c-1",
        category: "default",
        value: remembered("m1"),
      }),
    );
    await put("plain", { fingerprint: "fp", outcome });
    await put("erased-before", { $sealed: { salt: "s", data: "d" } });
    await storage.idempotencyStore.erase({ key: "erased-before", now });

    const swept = await reseal.answers(await storage.idempotencyStore.list({ now }), now);
    expect(swept.resealed).toBe(4);
    const after = new Map(
      (await storage.idempotencyStore.list({ now })).map((record) => [record.key, record]),
    );
    expect(after.get("current")?.persons).toEqual(named);
    expect(after.get("nobody")?.answer).not.toBeNull();
    for (const erased of ["other", "unmarked", "gone", "erased-before"]) {
      expect(after.get(erased)).toMatchObject({ answer: null, persons: [] });
    }
    expect(after.has("plain")).toBe(false);
    expect(after.get(await atRest.lookup("plain"))).toMatchObject({ answer: null });
    expect((await reseal.answers(await storage.idempotencyStore.list({ now }), now)).resealed).toBe(
      0,
    );
  });
});

describe("what the backfill rewrites and names beyond the marks of a field", () => {
  const started = Date.parse("2026-01-03T00:00:00.000Z");
  const upcasting = {
    ...aggregates,
    byName: {
      ...aggregates.byName,
      contact: {
        name: "contact",
        snapshot: null,
        eventsByType: {
          ContactAdded: {
            personal: { person: null, fields: ["email"], categories: {} },
            schemaVersion: 2,
            upcasts: [(payload: { mail?: string }) => ({ email: payload.mail })],
          },
          ContactNoted: {
            personal: { person: "customerId", fields: ["note"], categories: {} },
            schemaVersion: 2,
            upcasts: [
              (payload: { customerId?: string; text?: string }) => ({
                customerId: payload.customerId,
                note: payload.text,
              }),
            ],
          },
        },
      },
    },
  } as unknown as AggregatesRuntime;
  const delivery = {
    name: "shop.delivery",
    personal: { person: "agentId", fields: ["phone"], categories: {} },
    initialState: { agentId: null, phone: null },
    deadlineFields: [],
    instanceOf: (routed: { readonly aggregateId: string }) => {
      if (routed.aggregateId === "broken") throw new Error("cannot route");
      return routed.aggregateId;
    },
  };
  const warnings: unknown[] = [];
  const reseal = (storage: Storage) =>
    createResealBatches({
      storage,
      reading: storage.eventStore,
      aggregates: upcasting,
      processes: {
        byName: {
          ...processes.byName,
          "shop.delivery": delivery,
          "shop.unmarked": { ...delivery, name: "shop.unmarked", personal: null },
        },
      } as unknown as Pick<ProcessesRuntime, "byName">,
      wrapping: testWrapping(),
      atRest: null,
      marks: "m1",
      logger: { ...silentLogger, warn: (_message, fields) => warnings.push(fields) },
      recordsActivity: false,
    });
  const appendAll = async (storage: Storage, ...events: PendingEvent[]) => {
    for (const pending of events) {
      const { version } = await storage.eventStore.load({
        aggregateType: pending.aggregateType,
        aggregateId: pending.aggregateId,
      });
      await storage.eventStore.append({
        aggregateType: pending.aggregateType,
        aggregateId: pending.aggregateId,
        expectedVersion: version,
        events: [pending],
      });
    }
  };

  it("writes an event of an older shape in its current one only when told to, sealed, or as it is when it names nobody", async () => {
    const storage: Storage = await memory().createStorage();
    await appendAll(
      storage,
      event("contact", "c-1", 1, "ContactAdded", { mail: "ada@example.com" }),
      event("contact", "x-1", 1, "ContactNoted", {}),
    );
    const batches = reseal(storage);
    expect((await batches.events(await all(storage), false)).resealed).toBe(1);
    const [kept, untouched] = await all(storage);
    expect(kept?.metadata.schemaVersion).toBe(1);
    expect(kept?.payload).toEqual({ mail: "ada@example.com" });
    expect(untouched?.metadata.schemaVersion).toBe(1);

    expect((await batches.events(await all(storage), true)).resealed).toBe(2);
    const [added, noted] = await all(storage);
    expect(added?.metadata.schemaVersion).toBe(2);
    expect(added?.person).toBe("c-1");
    expect(Object.keys(added?.payload as object)).toEqual(["email"]);
    expect(isSealed(fieldOf(added?.payload, "email"))).toBe(true);
    expect(noted).toMatchObject({ person: null, payload: {}, metadata: { schemaVersion: 2 } });
    expect((await batches.events(await all(storage), true)).resealed).toBe(0);
  });

  it("seals a process letter's text under the person its instance's state named when the step failed, too", async () => {
    warnings.length = 0;
    const storage: Storage = await memory().createStorage();
    const stream = processAggregateType("shop.delivery");
    const lifecycle = (version: number, type: string, payload: object): PendingEvent => ({
      ...event(stream, "c-1", version, type, payload),
      metadata: { ...metadata, system: true },
    });
    await appendAll(
      storage,
      event("customer", "c-1", 1, "CustomerRegistered", { email: "ada@example.com" }),
      event("customer", "broken", 1, "CustomerRegistered", { email: "bob@example.com" }),
      lifecycle(1, "ProcessStarted", { state: { agentId: "a-1", phone: "+34" }, eventId: "e" }),
      lifecycle(2, "ProcessFailed", { eventId: "e", errorName: "Error", letterId: "l-1" }),
      lifecycle(3, "ProcessHandled", { state: { agentId: "a-2", phone: "+33" }, eventId: "f" }),
      lifecycle(4, "ProcessHandled", { state: { agentId: "a-3", phone: "+32" }, eventId: "g" }),
      lifecycle(5, "ProcessFailed", { eventId: "g", errorName: "Error", letterId: "l-2" }),
      lifecycle(6, "ProcessHandled", { state: { agentId: "a-4", phone: "+31" }, eventId: "h" }),
      forgotten("a-5"),
      {
        ...event(stream, "i-5", 1, "ProcessStarted", {
          state: { agentId: "a-5", phone: "+30" },
          eventId: "e",
        }),
        metadata: { ...metadata, system: true },
      },
    );
    await storage.personalKeys.add("c-1", "default", await newStoredKey());
    for (const person of ["a-1", "a-3", "a-4", "broken"]) {
      await storage.personalKeys.add(person, "default", await newStoredKey());
    }
    const filed = (id: string, overrides: Partial<NewDeadLetter>): NewDeadLetter => ({
      id,
      kind: "process",
      handler: "shop.delivery",
      eventId: "customer-c-1-1",
      eventType: "CustomerRegistered",
      aggregateType: "customer",
      aggregateId: "c-1",
      person: null,
      errorType: "terminal",
      errorName: "Error",
      errorMessage: "agent +34 away",
      errorStack: "Error: agent +34 away",
      attempts: 1,
      firstFailedAt: "2026-01-02T00:00:00.000Z",
      lastFailedAt: "2026-01-02T00:00:00.000Z",
      ...overrides,
    });
    const stackless = ({ errorStack: _, ...letter }: NewDeadLetter): NewDeadLetter => letter;
    await storage.deadLetterStore.add(filed("l-1", {}));
    await storage.deadLetterStore.add(filed("l-2", { person: "c-1", errorMessage: "sealed" }));
    await storage.deadLetterStore.add(
      stackless(filed("l-3", { aggregateType: stream, eventId: "deadline:x" })),
    );
    await storage.deadLetterStore.add(
      filed("l-4", { aggregateId: "broken", eventId: "customer-broken-1" }),
    );
    await storage.deadLetterStore.add(filed("l-5", { lastFailedAt: "2026-02-01T00:00:00.000Z" }));
    await storage.deadLetterStore.add(filed("l-6", { statePerson: "a-9", person: "c-1" }));
    await storage.deadLetterStore.add(filed("l-7", { lastFailedAt: "2026-01-03T00:00:00.000Z" }));
    await storage.deadLetterStore.add(stackless(filed("l-8", {})));
    await storage.deadLetterStore.add(filed("l-9", { eventId: "gone" }));
    await storage.deadLetterStore.add(filed("l-10", { handler: "shop.unknown" }));
    await storage.deadLetterStore.add(filed("l-11", { handler: "shop.unmarked" }));
    await storage.deadLetterStore.add(
      filed("l-12", {
        aggregateType: stream,
        aggregateId: "i-5",
        eventId: "deadline:y",
        person: "c-1",
        errorMessage: "sealed",
      }),
    );

    const batches = reseal(storage);
    const sealed = await batches.letters(await storage.deadLetterStore.list(), started);
    expect(sealed.resealed).toBe(8);
    expect(sealed.discarded).toBe(1);
    const after = new Map(
      (await storage.deadLetterStore.list()).map((letter) => [letter.id, letter]),
    );
    expect(after.get("l-1")).toMatchObject({ person: "c-1", statePerson: "a-1" });
    expect(after.get("l-1")?.errorStack).toBeDefined();
    expect(after.get("l-1")?.errorMessage).toMatchObject({ $personal: { person: "a-1" } });
    expect(after.get("l-1")?.errorStack).toMatchObject({ $personal: { person: "a-1" } });
    expect(after.get("l-2")).toMatchObject({ person: "c-1", statePerson: "a-3" });
    expect(after.get("l-2")?.errorMessage).toMatchObject({ $personal: { person: "a-3" } });
    expect(after.get("l-3")).toMatchObject({ person: "a-4" });
    expect(after.get("l-3")).not.toHaveProperty("statePerson");
    expect(after.get("l-3")).not.toHaveProperty("errorStack");
    expect(after.get("l-4")).toMatchObject({ person: "broken" });
    expect(after.get("l-4")).not.toHaveProperty("statePerson");
    expect(warnings).toEqual([
      expect.objectContaining({ letterId: "l-4", process: "shop.delivery" }),
    ]);
    expect(after.get("l-7")).toMatchObject({ person: null, errorMessage: "agent +34 away" });
    expect(after.get("l-8")).toMatchObject({ person: "c-1", statePerson: "a-4" });
    expect(after.get("l-8")).not.toHaveProperty("errorStack");
    expect(after.get("l-9")).toMatchObject({ person: null, errorMessage: "agent +34 away" });
    for (const id of ["l-10", "l-11"]) {
      expect(after.get(id)).toMatchObject({ person: "c-1" });
      expect(after.get(id)).not.toHaveProperty("statePerson");
    }
    expect(after.get("l-12")).toMatchObject({ person: "c-1", statePerson: "a-5" });

    expect(after.get("l-5")).toMatchObject({ person: null, errorMessage: "agent +34 away" });
    expect(after.get("l-6")).toMatchObject({ statePerson: "a-9", errorMessage: "agent +34 away" });

    const opened = openTextWith(sealedKeys(keysOver(storage.personalKeys)));
    expect(await opened(after.get("l-1")?.errorMessage ?? "")).toBe("agent +34 away");
    expect(await opened(after.get("l-12")?.errorMessage ?? "")).toBeNull();
    expect((await batches.letters(await storage.deadLetterStore.list(), started)).resealed).toBe(0);
  });

  it("names nobody more for a letter whose instance's state names its own person, or a process that marks nothing", async () => {
    const storage: Storage = await memory().createStorage();
    const stream = processAggregateType("shop.delivery");
    await appendAll(storage, {
      ...event(stream, "c-1", 1, "ProcessStarted", {
        state: { agentId: "c-1", phone: "+34" },
        eventId: "e",
      }),
      metadata: { ...metadata, system: true },
    });
    await storage.personalKeys.add("c-1", "default", await newStoredKey());
    const base: NewDeadLetter = {
      id: "same",
      kind: "process",
      handler: "shop.delivery",
      eventId: "deadline:x",
      eventType: "bounda.ProcessDeadline",
      aggregateType: stream,
      aggregateId: "c-1",
      person: "c-1",
      errorType: "terminal",
      errorName: "Error",
      errorMessage: "sealed",
      attempts: 1,
      firstFailedAt: "2026-01-02T00:00:00.000Z",
      lastFailedAt: "2026-01-02T00:00:00.000Z",
    };
    await storage.deadLetterStore.add(base);
    await storage.deadLetterStore.add({ ...base, id: "unmarked", handler: "signup.onboarding" });
    const sealed = await reseal(storage).letters(await storage.deadLetterStore.list(), started);
    expect(sealed.resealed).toBe(0);
    expect(await storage.deadLetterStore.get("same")).not.toHaveProperty("statePerson");
  });
});
