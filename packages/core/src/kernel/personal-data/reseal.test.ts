import { describe, expect, it, vi } from "vitest";
import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import {
  DEFAULT_PERSONAL_CATEGORY as D,
  type SealedValue,
} from "../../adapter/storage/personal-key-store.ts";
import { pendingEvent, testContext, testDeadLetter } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { LogFields, Logger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { LEASE_MS } from "../shared/lease.ts";
import { openTestTenantKeys, testMaster } from "../test-support.ts";
import { epochNumber, openDatabaseKey } from "./blind-index.ts";
import { seal, unseal } from "./crypto.ts";
import { sealUnderAll } from "./errors.ts";
import { HOLD_MS } from "./hold.ts";
import {
  createPersonalDataReseal,
  RESEAL_PREFIX,
  RESEAL_STEPS,
  RESEAL_SWITCH_MS,
  type ResealReadModels,
} from "./reseal.ts";
import { ROTATION_CHECK_INTERVAL_MS } from "./rotation.ts";
import { createPersonalKeyWrapping } from "./wrapped-keys.ts";

const START = new Date("2026-03-01T00:00:00.000Z");
const DAY = 86_400_000;

interface Logged {
  readonly level: string;
  readonly message: string;
  readonly fields?: LogFields | undefined;
}

const recording = (): Logger & { readonly logged: Logged[] } => {
  const logged: Logged[] = [];
  const at = (level: string) => (message: string, fields?: LogFields) => {
    logged.push({ level, message, fields });
  };
  return { logged, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
};

const setUp = async (readModels: ResealReadModels = { advance: async () => "ready" }) => {
  const clock = createFixedClock(START);
  const storage = await memory().createStorage();
  const tenantKeys = await openTestTenantKeys({ clock });
  const wrapping = createPersonalKeyWrapping({ tenantKeys, master: testMaster, clock });
  const keys = wrapping.over(storage.personalKeys);
  const databaseKey = await openDatabaseKey({ store: storage.indexKeys, wrapping, clock });
  const logger = recording();
  const reseal = createPersonalDataReseal({
    storage,
    wrapping,
    tenantKeys,
    databaseKey,
    readModels,
    batchSize: 2,
    clock,
    logger,
  });
  // What the rotation does while a reseal replaces: every key under an older version, replaced.
  const replaceAll = async (): Promise<number> => {
    const { kid, previous } = await wrapping.kids();
    const rows = await storage.personalKeys.listWrappedUnder({
      kids: previous.filter((each) => each !== kid),
      limit: 100,
    });
    for (const row of rows) await reseal.replace(row);
    return rows.length;
  };
  const sealed = async (person: string, value: unknown): Promise<SealedValue> =>
    seal({ key: await keys.create(person, D), person, category: D, value });
  const open = async (value: SealedValue) =>
    unseal({ key: await keys.opened(value.$personal.person, value.$personal.key), sealed: value });
  const row = (name: string) => checkpointRow(storage.checkpointStore, name);
  // From the start through the switch window, the keys replaced.
  const begun = async () => {
    clock.advance(1);
    await reseal.begin();
    await tenantKeys.rotate();
    await reseal.switchDatabaseKey();
    await replaceAll();
    clock.advance(RESEAL_SWITCH_MS);
  };
  const sweepUntil = async (step: string, limit = 50) => {
    for (let pass = 0; pass < limit; pass += 1) {
      if ((await reseal.status())?.step === step) return;
      await reseal.sweep(clock.now());
    }
    throw new Error(`never reached ${step}`);
  };
  return {
    clock,
    storage,
    tenantKeys,
    wrapping,
    keys,
    databaseKey,
    logger,
    reseal,
    replaceAll,
    sealed,
    open,
    row,
    begun,
    sweepUntil,
  };
};

// A sealed value a record holds in `name`.
const field = (record: unknown, name: string): SealedValue =>
  Reflect.get(Object(record), name) as SealedValue;

const checkpointRow = (
  checkpoints: { get(name: string): Promise<number> },
  name: string,
): Promise<number> => checkpoints.get(`${RESEAL_PREFIX}${name}`);

// Each call the reseal makes on a transaction's stores, its keys aside, and each key it reads
// outside one, as `<person>:<fingerprint>`; each taken once.
const observe = (storage: Storage) => {
  const calls: string[] = [];
  const outside: string[] = [];
  let inside = false;
  const recorded = (tx: StorageTransaction): StorageTransaction =>
    new Proxy(tx, {
      get: (target, name) => {
        const store: unknown = Reflect.get(target, name);
        if (typeof name !== "string" || name === "personalKeys") return store;
        if (typeof store !== "object" || store === null) return store;
        return new Proxy(store, {
          get: (inner, method) => {
            const call: unknown = Reflect.get(inner, method);
            if (typeof call !== "function" || typeof method !== "string") return call;
            return (...args: unknown[]) => {
              calls.push(`${name}.${method}`);
              return Reflect.apply(call, inner, args);
            };
          },
        });
      },
    });
  const transact = storage.transact.bind(storage);
  vi.spyOn(storage, "transact").mockImplementation(
    async <T>(work: (tx: StorageTransaction) => Promise<T>) =>
      transact(async (tx) => {
        inside = true;
        try {
          return await work(recorded(tx));
        } finally {
          inside = false;
        }
      }),
  );
  const find = storage.personalKeys.find.bind(storage.personalKeys);
  vi.spyOn(storage.personalKeys, "find").mockImplementation(async (person, fingerprint) => {
    if (!inside) outside.push(`${person}:${fingerprint}`);
    return find(person, fingerprint);
  });
  return { calls: () => calls.splice(0), outside: () => outside.splice(0) };
};

const stepRow = (step: (typeof RESEAL_STEPS)[number]): number => RESEAL_STEPS.indexOf(step) + 1;

describe("createPersonalDataReseal", () => {
  it("says nothing before any reseal, and reads the row once a check interval while none runs", async () => {
    const { reseal, storage, clock } = await setUp();
    expect(await reseal.status()).toBeNull();
    expect(await reseal.active()).toBe(false);
    expect(await reseal.replacing()).toBe(false);
    expect(await reseal.holdsSuperseded()).toBe(false);
    const read = vi.spyOn(storage.checkpointStore, "get");
    expect(await reseal.nextDueAt()).toBeNull();
    const reads = read.mock.calls.length;
    expect(await reseal.nextDueAt()).toBeNull();
    clock.advance(ROTATION_CHECK_INTERVAL_MS - 1);
    expect(await reseal.nextDueAt()).toBeNull();
    expect(read.mock.calls.length).toBe(reads);
    clock.advance(1);
    expect(await reseal.nextDueAt()).toBeNull();
    expect(read.mock.calls.length).toBeGreaterThan(reads);
    expect(await reseal.sweep(clock.now())).toBe(0);
  });

  it("begins replacing, and waits for the tenant's rotation, the database's key and the switch window", async () => {
    const { reseal, tenantKeys, clock, storage, logger, replaceAll, sealed, row } = await setUp();
    await sealed("ana", "ana@x");
    // A version of the tenant's key from before the reseal began.
    clock.advance(1);
    await reseal.begin();
    expect(logger.logged).toContainEqual({
      level: "warn",
      message: "personal data reseal started: every key that seals it will be replaced",
      fields: undefined,
    });
    expect(await reseal.status()).toEqual({
      step: "replacing",
      startedAt: new Date(START.getTime() + 1).toISOString(),
      completedAt: null,
      superseded: 0,
    });
    expect(await reseal.active()).toBe(true);
    expect(await reseal.replacing()).toBe(true);
    expect(await reseal.holdsSuperseded()).toBe(true);
    // Due now while the database's key is not switched yet.
    expect(await reseal.nextDueAt()).toEqual(clock.now());
    // Not rotated yet: nothing moves.
    expect(await reseal.sweep(clock.now())).toBe(0);
    expect(await row("switched")).toBe(0);
    const before = await storage.indexKeys.get();
    clock.advance(1_000);
    await tenantKeys.rotate();
    expect(await reseal.sweep(clock.now())).toBe(0);
    const switchedAt = await row("switched");
    expect(switchedAt).toBe(START.getTime() + 1_001);
    expect((await storage.indexKeys.previous())?.fingerprint).toBe(before?.fingerprint);
    const after = await storage.indexKeys.get();
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
    expect(await epochNumber(after?.fingerprint ?? "")).not.toBe(
      await epochNumber(before?.fingerprint ?? ""),
    );
    expect(after?.kid).toBe((await tenantKeys.kids()).kid);
    expect(await reseal.nextDueAt()).toEqual(new Date(switchedAt + RESEAL_SWITCH_MS));
    // The window passed, a key is still under the older version.
    clock.advance(RESEAL_SWITCH_MS);
    expect(await reseal.sweep(clock.now())).toBe(0);
    expect(await row("switched")).toBe(switchedAt);
    expect(await replaceAll()).toBe(1);
    expect(await reseal.sweep(clock.now())).toBe(1);
    expect((await reseal.status())?.step).toBe("events");
    expect(await reseal.replacing()).toBe(false);
    expect(logger.logged).toContainEqual({
      level: "info",
      message: "personal data reseal moved on",
      fields: { step: "events" },
    });
  });

  it("rotates the tenant's key itself once the call that began the reseal stopped before it did", async () => {
    const { reseal, tenantKeys, clock } = await setUp();
    const { kid } = await tenantKeys.kids();
    clock.advance(1);
    await reseal.begin();
    clock.advance(LEASE_MS - 1);
    await reseal.sweep(clock.now());
    expect((await tenantKeys.kids()).kid).toBe(kid);
    clock.advance(1);
    await reseal.sweep(clock.now());
    expect((await tenantKeys.kids()).kid).not.toBe(kid);
  });

  it("seals again every store under the new keys, and destroys the old keys in its last transaction", async () => {
    const advance = vi.fn<ResealReadModels["advance"]>();
    advance.mockResolvedValueOnce("progressed").mockResolvedValue("ready");
    const {
      reseal,
      storage,
      clock,
      keys,
      sealed,
      open,
      begun,
      sweepUntil,
      row,
      logger,
      databaseKey,
    } = await setUp({ advance });
    const email = await sealed("ana", "ana@x");
    const other = await sealed("bob", "bob@x");
    const fingerprintOf = (value: SealedValue) => value.$personal.key;
    const old = new Set([fingerprintOf(email), fingerprintOf(other)]);
    await storage.eventStore.append({
      aggregateType: "customer",
      aggregateId: "ana",
      expectedVersion: 0,
      events: [
        pendingEvent({
          aggregateType: "customer",
          aggregateId: "ana",
          version: 1,
          payload: { email, plan: "pro" },
          person: "ana",
        }),
        pendingEvent({ aggregateType: "customer", aggregateId: "ana", version: 2 }),
        pendingEvent({
          aggregateType: "customer",
          aggregateId: "ana",
          version: 3,
          payload: { state: { contact: email } },
          person: "ana",
        }),
      ],
    });
    await storage.scheduler.schedule({
      dedupeKey: "mail-ana",
      command: { type: "MailCustomer", payload: { email }, aggregateId: "ana" },
      executeAt: new Date(START.getTime() + DAY),
      scheduledAt: START,
      context: testContext,
      persons: [{ person: "ana", fingerprint: fingerprintOf(email) }],
    });
    await storage.scheduler.schedule({
      dedupeKey: "plain",
      command: { type: "Tick", payload: { n: 1 }, aggregateId: "x" },
      executeAt: new Date(START.getTime() + DAY),
      scheduledAt: START,
      context: testContext,
    });
    const layered = await sealUnderAll(
      [{ category: D, key: await keys.create("bob", D), retainedSince: null }],
      "bob",
      await sealUnderAll(
        [{ category: D, key: await keys.create("ana", D), retainedSince: null }],
        "ana",
        "cannot mail ana@x",
      ),
    );
    await storage.deadLetterStore.add({
      ...testDeadLetter("d-1"),
      person: "bob",
      statePerson: "ana",
      errorMessage: layered,
      errorStack: layered,
      payload: { email },
      persons: [{ person: "ana", fingerprint: fingerprintOf(email) }],
    });
    await storage.deadLetterStore.add(testDeadLetter("d-plain"));
    await storage.subscriberFailures.record({
      subscriber: "projection:customers",
      position: 1,
      eventId: "e-1",
      eventType: "CustomerRegistered",
      person: "ana",
      errorName: "Error",
      errorMessage: email,
      errorStack: email,
      failedAt: START.toISOString(),
    });
    await storage.subscriberFailures.record({
      subscriber: "projection:plain",
      position: 1,
      eventId: "e-2",
      eventType: "Tick",
      person: null,
      errorName: "Error",
      errorMessage: "in the clear",
      failedAt: START.toISOString(),
    });
    const expiresAt = new Date(START.getTime() + 3 * DAY).toISOString();
    await storage.idempotencyStore.put({
      key: "a-1",
      answer: email,
      expiresAt,
      persons: [{ person: "ana", fingerprint: fingerprintOf(email) }],
      now: clock.now(),
    });
    await storage.idempotencyStore.put({
      key: "a-2",
      answer: await databaseKey.atRest.seal("at rest"),
      expiresAt: new Date(START.getTime() + DAY).toISOString(),
      persons: [],
      now: clock.now(),
    });
    await storage.idempotencyStore.put({
      key: "a-3",
      answer: { $sealed: { salt: "AAAAAAAAAAAAAAAAAAAAAA==", data: "AAAAAAAAAAAAAAAAAAAAAA==" } },
      expiresAt: new Date(START.getTime() + DAY).toISOString(),
      persons: [],
      now: clock.now(),
    });
    await storage.idempotencyStore.put({
      key: "a-4",
      answer: { outcome: "in the clear" },
      expiresAt: new Date(START.getTime() + DAY).toISOString(),
      persons: [],
      now: clock.now(),
    });
    await storage.snapshotStore.put({
      aggregateType: "customer",
      aggregateId: "ana",
      version: 1,
      fingerprint: "f",
      state: "{}",
      persons: [],
    });

    await begun();
    await sweepUntil("expiring");
    expect(advance).toHaveBeenCalledTimes(2);
    expect(advance).toHaveBeenCalledWith(await storage.eventStore.lastPosition());
    expect(logger.logged).toContainEqual({
      level: "info",
      message: "every person's key is replaced, and the old ones destroyed",
      fields: { destroyed: 2 },
    });
    const text = JSON.stringify([
      await storage.eventStore.readAll({ afterPosition: 0, limit: 10 }),
      await storage.scheduler.list(),
      await storage.deadLetterStore.list(),
      await storage.subscriberFailures.list(),
      await storage.idempotencyStore.list({ now: clock.now() }),
    ]);
    for (const fingerprint of old) expect(text).not.toContain(fingerprint);
    const [first, plain, state] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(await open(field(first?.payload, "email"))).toBe("ana@x");
    expect(plain?.payload).toEqual({ total: 2 });
    expect(await open(field(field(state?.payload, "state"), "contact"))).toBe("ana@x");
    const mail = await storage.scheduler.get("mail-ana");
    const mailed = field(mail?.command.payload, "email");
    expect(await open(mailed)).toBe("ana@x");
    expect(mail?.persons?.[0]?.fingerprint).toBe(mailed.$personal.key);
    expect((await storage.scheduler.get("plain"))?.command.payload).toEqual({ n: 1 });
    const letter = await storage.deadLetterStore.get("d-1");
    expect(letter).toMatchObject({ person: "bob", statePerson: "ana" });
    expect(await open(field(letter?.payload, "email"))).toBe("ana@x");
    const failures = await storage.subscriberFailures.list();
    expect(failures.find(({ eventId }) => eventId === "e-2")?.errorMessage).toBe("in the clear");
    const failure = failures.find(({ eventId }) => eventId === "e-1");
    expect(await open(failure?.errorMessage as SealedValue)).toBe("ana@x");
    expect(await open(failure?.errorStack as SealedValue)).toBe("ana@x");
    expect((await storage.idempotencyStore.get({ key: "a-3", now: clock.now() }))?.answer).toBe(
      null,
    );
    expect((await storage.idempotencyStore.get({ key: "a-4", now: clock.now() }))?.answer).toEqual({
      outcome: "in the clear",
    });
    const answer = await storage.idempotencyStore.get({ key: "a-1", now: clock.now() });
    const remembered = answer?.answer as SealedValue;
    expect(await open(remembered)).toBe("ana@x");
    expect(answer?.persons[0]?.fingerprint).toBe(remembered.$personal.key);
    expect(await storage.snapshotStore.get({ aggregateType: "customer", aggregateId: "ana" })).toBe(
      null,
    );
    expect(await storage.personalKeys.countSuperseded()).toBe(0);
    expect(await reseal.holdsSuperseded()).toBe(false);
    expect(await reseal.active()).toBe(true);
    // The previous database key waits for the last answer filed under it.
    expect(await row("answers-until")).toBe(START.getTime() + 3 * DAY);
    expect(await reseal.nextDueAt()).toEqual(new Date(START.getTime() + 3 * DAY));
    expect(await reseal.sweep(clock.now())).toBe(0);
    expect(await storage.indexKeys.previous()).not.toBeNull();
    clock.set(new Date(START.getTime() + 3 * DAY));
    expect(await reseal.sweep(clock.now())).toBe(1);
    expect(await storage.indexKeys.previous()).toBeNull();
    expect(await reseal.status()).toEqual({
      step: "complete",
      startedAt: null,
      completedAt: new Date(START.getTime() + 3 * DAY).toISOString(),
      superseded: 0,
    });
    for (const name of ["step", "cursor", "switched", "answers-until", "started"]) {
      expect(await row(name)).toBe(0);
    }
    expect(logger.logged).toContainEqual({
      level: "info",
      message: "personal data resealed: every key that sealed it before is destroyed",
      fields: undefined,
    });
    expect(await reseal.active()).toBe(false);
  });

  it("writes in each pass only what changes, unwraps ahead each key a batch names, and rewrites nothing again", async () => {
    const { reseal, storage, clock, keys, sealed, begun, databaseKey, row } = await setUp();
    const ana = await sealed("ana", "ana@x");
    const bob = await sealed("bob", "bob@x");
    const carl = await sealed("carl", "carl@x");
    const A = ana.$personal.key;
    const customer = { aggregateType: "customer", aggregateId: "ana" };
    await storage.eventStore.append({
      ...customer,
      expectedVersion: 0,
      events: [
        pendingEvent({ ...customer, version: 1, payload: { email: ana, again: ana, other: bob } }),
        pendingEvent({ ...customer, version: 2, payload: { state: { contact: ana } } }),
        pendingEvent({ ...customer, version: 3 }),
        pendingEvent({ ...customer, version: 4 }),
      ],
    });
    const schedule = (dedupeKey: string, hours: number, payload: object, persons?: object[]) =>
      storage.scheduler.schedule({
        dedupeKey,
        command: { type: "Mail", payload, aggregateId: "ana" },
        executeAt: new Date(START.getTime() + hours * 3_600_000),
        scheduledAt: START,
        context: testContext,
        ...(persons === undefined ? {} : { persons: persons as never }),
      });
    await schedule("s-1", 1, { email: ana });
    await schedule("s-2", 2, { n: 1 }, [{ person: "ana", fingerprint: A }]);
    await schedule("s-3", 3, { n: 2 });
    const layered = await sealUnderAll(
      [{ category: D, key: await keys.create("bob", D), retainedSince: null }],
      "bob",
      await sealUnderAll(
        [{ category: D, key: await keys.create("ana", D), retainedSince: null }],
        "ana",
        "cannot mail ana@x",
      ),
    );
    const stack = await sealUnderAll(
      [{ category: D, key: await keys.create("carl", D), retainedSince: null }],
      "carl",
      "at carl@x",
    );
    const named = [{ person: "ana", fingerprint: A }];
    await storage.deadLetterStore.add({
      ...testDeadLetter("d-1"),
      person: "bob",
      statePerson: "ana",
      errorMessage: layered,
      errorStack: stack,
      payload: { email: ana },
      persons: named,
    });
    await storage.deadLetterStore.add({ ...testDeadLetter("d-2"), errorMessage: ana });
    await storage.deadLetterStore.add({ ...testDeadLetter("d-3"), errorStack: carl });
    await storage.deadLetterStore.add({ ...testDeadLetter("d-4"), payload: { email: ana } });
    await storage.deadLetterStore.add({ ...testDeadLetter("d-5"), persons: named });
    await storage.deadLetterStore.add(testDeadLetter("d-6"));
    const fail = (subscriber: string, errorMessage: unknown, errorStack?: unknown) =>
      storage.subscriberFailures.record({
        subscriber,
        position: 1,
        eventId: "e-1",
        eventType: "CustomerRegistered",
        person: "ana",
        errorName: "Error",
        errorMessage: errorMessage as SealedValue,
        ...(errorStack === undefined ? {} : { errorStack: errorStack as SealedValue }),
        failedAt: START.toISOString(),
      });
    await fail("f-1", ana, ana);
    await fail("f-2", "in the clear");
    await fail("f-3", "in the clear", ana);
    await fail("f-4", ana);
    const remember = (key: string, answer: unknown, persons: object[], days = 1) =>
      storage.idempotencyStore.put({
        key,
        answer: answer as SealedValue,
        expiresAt: new Date(START.getTime() + days * DAY).toISOString(),
        persons: persons as never,
        now: clock.now(),
      });
    await remember("a-1", ana, named, 3);
    await remember("a-2", await databaseKey.atRest.seal("at rest"), []);
    await remember("a-3", { $sealed: { salt: "AAAAAAAAAAAAAAAAAAAAAA==", data: "AAAA" } }, []);
    await remember("a-4", { outcome: "in the clear" }, []);
    await remember("a-5", ana, []);
    await storage.idempotencyStore.erase({ key: "a-5", now: clock.now() });
    await remember("a-6", { outcome: "in the clear" }, named);
    await remember("a-7", ana, [], 3);

    await begun();
    const fresh = new Map<string, string>();
    for (const person of ["ana", "bob", "carl"]) {
      fresh.set(person, (await storage.personalKeys.get(person, D))?.fingerprint ?? "");
    }
    const was = new Map([
      [A, "ana"],
      [bob.$personal.key, "bob"],
      [carl.$personal.key, "carl"],
    ]);
    // A key read outside a transaction, `ana` for the replaced key and `ana'` for its successor.
    const label = (read: string): string => {
      const [person = "", fingerprint = ""] = read.split(":");
      if (was.get(fingerprint) === person) return person;
      return fresh.get(person) === fingerprint ? `${person}'` : read;
    };
    const seen = observe(storage);
    const answersUntil = vi.spyOn(storage.checkpointStore, "set");
    const failures = vi.spyOn(storage.subscriberFailures, "reseal");
    const pass = async () => {
      const done = await reseal.sweep(clock.now());
      return { done, calls: seen.calls(), outside: seen.outside().map(label) };
    };
    const get = (name: string, times: number) => Array<string>(times).fill(name);

    expect(await pass()).toEqual({ done: 1, calls: [], outside: [] });
    expect(await pass()).toEqual({
      done: 4,
      calls: [...get("eventStore.readOne", 2), "eventStore.reseal"],
      outside: ["ana", "ana'", "bob", "bob'"],
    });
    // A batch with nothing sealed opens no transaction.
    const transactions = vi.mocked(storage.transact).mock.calls.length;
    expect(await pass()).toEqual({ done: 2, calls: [], outside: [] });
    expect(vi.mocked(storage.transact).mock.calls.length).toBe(transactions);
    expect(await pass()).toEqual({ done: 1, calls: [], outside: [] });
    expect((await reseal.status())?.step).toBe("scheduled");
    expect(await pass()).toEqual({
      done: 3,
      calls: ["scheduler.get", "scheduler.reseal", "scheduler.get", "scheduler.reseal"],
      outside: ["ana", "ana'"],
    });
    expect(await pass()).toEqual({ done: 1, calls: ["scheduler.get"], outside: [] });
    expect(await pass()).toEqual({ done: 1, calls: [], outside: [] });
    const scheduledText = JSON.stringify(await storage.scheduler.list());
    for (const fingerprint of was.keys()) expect(scheduledText).not.toContain(fingerprint);
    expect((await reseal.status())?.step).toBe("letters");
    const resealing = ["deadLetterStore.get", "deadLetterStore.reseal"];
    expect(await pass()).toEqual({
      done: 3,
      calls: [...resealing, ...resealing],
      outside: ["bob", "bob'", "carl", "carl'", "ana", "ana'"],
    });
    expect(await pass()).toEqual({
      done: 3,
      calls: [...resealing, ...resealing],
      outside: ["carl", "carl'", "ana", "ana'"],
    });
    expect(await pass()).toEqual({
      done: 2,
      calls: [...resealing, "deadLetterStore.get"],
      outside: [],
    });
    expect(await pass()).toEqual({ done: 1, calls: [], outside: [] });
    const letters = await storage.deadLetterStore.list();
    for (const fingerprint of was.keys())
      expect(JSON.stringify(letters)).not.toContain(fingerprint);
    const letter = (id: string) => letters.find((each) => each.id === id);
    expect(letter("d-1")).toMatchObject({
      person: "bob",
      statePerson: "ana",
      persons: [{ person: "ana", fingerprint: fresh.get("ana") }],
    });
    expect(field(letter("d-1"), "errorStack").$personal.key).toBe(fresh.get("carl"));
    expect(field(letter("d-3"), "errorStack").$personal.key).toBe(fresh.get("carl"));
    expect(letter("d-5")?.persons).toEqual([{ person: "ana", fingerprint: fresh.get("ana") }]);
    expect(letter("d-6")).toEqual({ ...testDeadLetter("d-6"), status: "failed" });
    expect((await reseal.status())?.step).toBe("failures");
    // Read outside any transaction, each failure's text opened there.
    expect(await pass()).toEqual({
      done: 4,
      calls: [],
      outside: Array<string[]>(4).fill(["ana", "ana'"]).flat(),
    });
    expect(failures.mock.calls.map(([subscriber]) => subscriber)).toEqual(["f-1", "f-3", "f-4"]);
    expect((await reseal.status())?.step).toBe("answers");
    answersUntil.mockClear();
    expect(await pass()).toEqual({
      done: 3,
      calls: [
        "idempotencyStore.get",
        "idempotencyStore.reseal",
        "idempotencyStore.get",
        "idempotencyStore.reseal",
      ],
      outside: ["ana", "ana'"],
    });
    expect(await pass()).toEqual({
      done: 2,
      calls: ["idempotencyStore.get", "idempotencyStore.erase", "idempotencyStore.get"],
      outside: [],
    });
    expect(await pass()).toEqual({
      done: 2,
      calls: ["idempotencyStore.get", "idempotencyStore.get", "idempotencyStore.reseal"],
      outside: [],
    });
    expect(await pass()).toEqual({
      done: 2,
      calls: ["idempotencyStore.get", "idempotencyStore.reseal"],
      outside: ["ana", "ana'"],
    });
    expect(await pass()).toEqual({ done: 1, calls: [], outside: [] });
    expect(
      answersUntil.mock.calls.filter(([name]) => name === `${RESEAL_PREFIX}answers-until`),
    ).toEqual([[`${RESEAL_PREFIX}answers-until`, START.getTime() + 3 * DAY]]);
    const answered = JSON.stringify(await storage.idempotencyStore.list({ now: clock.now() }));
    for (const fingerprint of was.keys()) expect(answered).not.toContain(fingerprint);
    expect((await storage.idempotencyStore.get({ key: "a-5", now: clock.now() }))?.answer).toBe(
      null,
    );
    expect((await reseal.status())?.step).toBe("snapshots");
    expect(await pass()).toEqual({ done: 1, calls: [], outside: [] });
    expect(await pass()).toEqual({ done: 1, calls: [], outside: [] });
    expect((await reseal.status())?.step).toBe("sealing");
    expect(await pass()).toEqual({
      done: 4,
      calls: [
        "scheduler.list",
        ...get("scheduler.get", 3),
        "deadLetterStore.list",
        ...get("deadLetterStore.get", 6),
      ],
      outside: ["ana'", "bob'", "carl'"],
    });
    expect((await reseal.status())?.step).toBe("expiring");
    expect(await row("answers-until")).toBe(START.getTime() + 3 * DAY);

    // Resumed from the events after it moved on, as a copy restored from then would: nothing is
    // written again but the answer sealed at rest, which does not say which key it is under.
    await storage.checkpointStore.set(`${RESEAL_PREFIX}step`, stepRow("events"));
    await storage.checkpointStore.set(`${RESEAL_PREFIX}cursor`, 0);
    failures.mockClear();
    const writes: string[] = [];
    while ((await reseal.status())?.step !== "snapshots") {
      writes.push(...(await pass()).calls.filter((call) => !/\.(get|readOne)$/.test(call)));
    }
    expect(writes).toEqual(["idempotencyStore.reseal"]);
    expect(failures).not.toHaveBeenCalled();
  });

  it("switches the database's key once, to one whose epoch differs, and marks when it did", async () => {
    const { reseal, storage, clock, wrapping, databaseKey, tenantKeys, row } = await setUp();
    const from = await storage.indexKeys.get();
    if (from === null) throw new Error("no database key");
    const generate = wrapping.generate.bind(wrapping);
    const generated = vi
      .spyOn(wrapping, "generate")
      .mockImplementationOnce(async () => ({ ...(await generate()), stored: from }));
    const refresh = vi.spyOn(databaseKey, "refresh");
    clock.advance(1);
    await reseal.begin();
    await reseal.switchDatabaseKey();
    const to = await storage.indexKeys.get();
    expect(generated).toHaveBeenCalledTimes(2);
    expect(to?.fingerprint).not.toBe(from.fingerprint);
    expect(await epochNumber(to?.fingerprint ?? "")).not.toBe(await epochNumber(from.fingerprint));
    expect(refresh).toHaveBeenCalledTimes(1);
    const switched = await row("switched");
    expect(switched).toBe(START.getTime() + 1);
    clock.advance(1_000);
    await reseal.switchDatabaseKey();
    expect((await storage.indexKeys.previous())?.fingerprint).toBe(from.fingerprint);
    expect((await storage.indexKeys.get())?.fingerprint).toBe(to?.fingerprint);
    expect(await row("switched")).toBe(switched);
    expect(generated).toHaveBeenCalledTimes(2);
    // A pass while the keys are replaced switches nothing again.
    await tenantKeys.rotate();
    refresh.mockClear();
    expect(await reseal.sweep(clock.now())).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reads the tenant's key again only while it reads as rotated before the reseal began", async () => {
    const { reseal, tenantKeys, clock } = await setUp();
    const refresh = vi.spyOn(tenantKeys, "refresh");
    clock.advance(1);
    await reseal.begin();
    await reseal.sweep(clock.now());
    expect(refresh).toHaveBeenCalledTimes(1);
    // Rotated the moment the reseal began, as the call that begins it does.
    await tenantKeys.rotate();
    await reseal.sweep(clock.now());
    refresh.mockClear();
    await reseal.sweep(clock.now());
    expect(refresh).not.toHaveBeenCalled();
  });

  it("waits the switch window from the later of the rotation and the switch", async () => {
    const { reseal, tenantKeys, clock, replaceAll } = await setUp();
    clock.advance(1);
    await reseal.begin();
    await reseal.switchDatabaseKey();
    clock.advance(1_000);
    await tenantKeys.rotate();
    await replaceAll();
    expect(await reseal.sweep(clock.now())).toBe(0);
    clock.advance(RESEAL_SWITCH_MS - 1);
    expect(await reseal.sweep(clock.now())).toBe(0);
    clock.advance(1);
    expect(await reseal.sweep(clock.now())).toBe(1);
  });

  it("reseals without a database key of its own, and leaves an answer sealed at rest as it is", async () => {
    const { storage, clock, wrapping, tenantKeys, databaseKey, replaceAll } = await setUp();
    const atRest = await databaseKey.atRest.seal("at rest");
    await storage.idempotencyStore.put({
      key: "a-1",
      answer: atRest,
      expiresAt: new Date(START.getTime() + DAY).toISOString(),
      persons: [],
      now: clock.now(),
    });
    const from = await storage.indexKeys.get();
    const reseal = createPersonalDataReseal({
      storage,
      wrapping,
      tenantKeys,
      databaseKey: null,
      readModels: { advance: async () => "ready" },
      batchSize: 2,
      clock,
      logger: recording(),
    });
    clock.advance(1);
    await reseal.begin();
    await tenantKeys.rotate();
    await reseal.switchDatabaseKey();
    expect((await storage.indexKeys.previous())?.fingerprint).toBe(from?.fingerprint);
    await replaceAll();
    clock.advance(RESEAL_SWITCH_MS);
    for (let pass = 0; pass < 20 && (await reseal.status())?.step !== "expiring"; pass += 1) {
      await reseal.sweep(clock.now());
    }
    expect((await reseal.status())?.step).toBe("expiring");
    expect((await storage.idempotencyStore.get({ key: "a-1", now: clock.now() }))?.answer).toEqual(
      atRest,
    );
    clock.set(new Date(START.getTime() + DAY));
    expect(await reseal.sweep(clock.now())).toBe(1);
    expect(await storage.indexKeys.previous()).toBeNull();
    expect((await reseal.status())?.step).toBe("complete");
  });

  it("reseals a store that holds no database key, and waits for no answer to expire", async () => {
    const clock = createFixedClock(START);
    const storage = await memory().createStorage();
    const tenantKeys = await openTestTenantKeys({ clock });
    const wrapping = createPersonalKeyWrapping({ tenantKeys, master: testMaster, clock });
    const reseal = createPersonalDataReseal({
      storage,
      wrapping,
      tenantKeys,
      databaseKey: null,
      readModels: { advance: async () => "ready" },
      batchSize: 2,
      clock,
      logger: recording(),
    });
    await storage.idempotencyStore.put({
      key: "a-1",
      answer: { outcome: "in the clear" },
      expiresAt: new Date(START.getTime() + DAY).toISOString(),
      persons: [],
      now: clock.now(),
    });
    clock.advance(1);
    await reseal.begin();
    await tenantKeys.rotate();
    await reseal.switchDatabaseKey();
    expect(await storage.indexKeys.get()).toBeNull();
    expect(await storage.indexKeys.previous()).toBeNull();
    expect(await checkpointRow(storage.checkpointStore, "switched")).toBe(START.getTime() + 1);
    clock.advance(RESEAL_SWITCH_MS);
    for (let pass = 0; pass < 20 && (await reseal.status())?.step !== "expiring"; pass += 1) {
      await reseal.sweep(clock.now());
    }
    expect(await checkpointRow(storage.checkpointStore, "answers-until")).toBe(
      START.getTime() + DAY,
    );
    expect(await reseal.nextDueAt()).toEqual(clock.now());
    expect(await reseal.sweep(clock.now())).toBe(1);
    expect((await reseal.status())?.step).toBe("complete");
  });

  it("skips what its transaction no longer finds", async () => {
    const { storage, clock, sealed, begun, sweepUntil, logger } = await setUp();
    const email = await sealed("ana", "ana@x");
    const customer = { aggregateType: "customer", aggregateId: "ana" };
    await storage.eventStore.append({
      ...customer,
      expectedVersion: 0,
      events: [pendingEvent({ ...customer, version: 1, payload: { email } })],
    });
    await storage.scheduler.schedule({
      dedupeKey: "mail",
      command: { type: "Mail", payload: { email }, aggregateId: "ana" },
      executeAt: new Date(START.getTime() + DAY),
      scheduledAt: START,
      context: testContext,
    });
    await storage.deadLetterStore.add({ ...testDeadLetter("d-1"), payload: { email } });
    await storage.idempotencyStore.put({
      key: "a-1",
      answer: email,
      expiresAt: new Date(START.getTime() + DAY).toISOString(),
      persons: [],
      now: clock.now(),
    });
    await begun();
    const reads: Readonly<Record<string, string>> = {
      eventStore: "readOne",
      scheduler: "get",
      deadLetterStore: "get",
      idempotencyStore: "get",
    };
    const transact = storage.transact.bind(storage);
    vi.spyOn(storage, "transact").mockImplementation(
      async <T>(work: (tx: StorageTransaction) => Promise<T>) =>
        transact((tx) =>
          work(
            new Proxy(tx, {
              get: (target, name) => {
                const store: unknown = Reflect.get(target, name);
                const read = typeof name === "string" ? reads[name] : undefined;
                return read === undefined ? store : { ...Object(store), [read]: async () => null };
              },
            }),
          ),
        ),
    );
    await sweepUntil("snapshots");
    expect(logger.logged.filter(({ level }) => level === "error")).toEqual([]);
    const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 1 });
    expect(field(event?.payload, "email")).toEqual(email);
    expect((await storage.idempotencyStore.get({ key: "a-1", now: clock.now() }))?.answer).toEqual(
      email,
    );
  });

  it("pages the answers past the furthest key its rows name, whichever order they are listed in", async () => {
    const { reseal, storage, clock, begun, sweepUntil, row } = await setUp();
    for (const key of ["a-1", "a-2", "a-3"]) {
      await storage.idempotencyStore.put({
        key,
        answer: { outcome: key },
        expiresAt: new Date(START.getTime() + DAY).toISOString(),
        persons: [],
        now: clock.now(),
      });
    }
    await begun();
    await sweepUntil("answers");
    // As a pass that stopped before it removed the row before its own leaves them.
    await storage.checkpointStore.set(`${RESEAL_PREFIX}answers-after:a-2`, 1);
    await storage.checkpointStore.set(`${RESEAL_PREFIX}answers-after:a-1`, 1);
    const list = vi.spyOn(storage.idempotencyStore, "list");
    await reseal.sweep(clock.now());
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ after: "a-2" }));
    expect(await row("answers-after:a-1")).toBe(0);
    expect(await row("answers-after:a-2")).toBe(0);
    expect(await row("answers-after:a-3")).toBe(1);
  });

  it("begins anew past a complete reseal, clears what a stopped one left, and says it is not complete", async () => {
    const { reseal, storage, clock, begun, sweepUntil, row } = await setUp();
    await begun();
    await sweepUntil("complete");
    expect((await reseal.status())?.completedAt).not.toBeNull();
    for (const name of ["step", "cursor", "switched", "answers-until", "answers-after:k"]) {
      await storage.checkpointStore.set(`${RESEAL_PREFIX}${name}`, 5);
    }
    clock.advance(1);
    await reseal.begin();
    for (const name of ["step", "cursor", "switched", "answers-until", "answers-after:k"]) {
      expect(await row(name)).toBe(0);
    }
    expect(await reseal.status()).toEqual({
      step: "replacing",
      startedAt: clock.now().toISOString(),
      completedAt: null,
      superseded: 0,
    });
  });

  it("leaves the lease to another until it lapses, gives it back, and forgets whose it was once restored", async () => {
    const { reseal, storage, clock, begun, row } = await setUp();
    await begun();
    const lease = `${RESEAL_PREFIX}lease`;
    const until = clock.now().getTime() + LEASE_MS;
    await storage.checkpointStore.set(lease, until);
    expect(await reseal.sweep(clock.now())).toBe(0);
    const read = vi.spyOn(storage.checkpointStore, "get");
    expect(await reseal.sweep(clock.now())).toBe(0);
    expect(read.mock.calls.map(([name]) => name)).not.toContain(lease);
    expect((await reseal.nextDueAt())?.getTime()).toBe(until);
    clock.set(new Date(until));
    expect(await reseal.sweep(clock.now())).toBe(1);
    expect(await row("lease")).toBe(until + LEASE_MS);
    await reseal.release();
    expect(await row("lease")).toBe(until);
    await storage.checkpointStore.set(lease, until + LEASE_MS);
    expect(await reseal.sweep(clock.now())).toBe(0);
    // The copy restored holds no lease.
    await storage.checkpointStore.set(lease, 0);
    await reseal.restored();
    expect(await reseal.sweep(clock.now())).toBe(1);
  });

  it("waits after a failure as long as after the first once a pass went through between", async () => {
    const { reseal, storage, clock, begun } = await setUp();
    await begun();
    await reseal.sweep(clock.now());
    vi.spyOn(storage.eventStore, "readAll").mockRejectedValueOnce(new Error("down"));
    expect(await reseal.sweep(clock.now())).toBe(0);
    expect(await reseal.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MS));
    clock.advance(HOLD_MS);
    expect(await reseal.sweep(clock.now())).toBe(1);
    vi.spyOn(storage.scheduler, "list").mockRejectedValueOnce(new Error("down"));
    expect(await reseal.sweep(clock.now())).toBe(0);
    expect(await reseal.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MS));
  });

  it("goes on past a failure at the next pass, longer after each, and leaves a lease another holds", async () => {
    const { reseal, storage, clock, begun, logger } = await setUp();
    await begun();
    expect(await reseal.sweep(clock.now())).toBe(1);
    const failing = vi
      .spyOn(storage.eventStore, "readAll")
      .mockRejectedValueOnce(new Error("the store is down"));
    expect(await reseal.sweep(clock.now())).toBe(0);
    expect(await reseal.sweep(clock.now())).toBe(0);
    expect(logger.logged.filter(({ level }) => level === "error")).toEqual([
      {
        level: "error",
        message: "personal data reseal failed; it goes on at the next pass",
        fields: { error: new Error("the store is down") },
      },
    ]);
    expect((await reseal.nextDueAt())?.getTime()).toBeGreaterThan(clock.now().getTime());
    await reseal.restored();
    expect(await reseal.nextDueAt()).toEqual(clock.now());
    failing.mockRestore();
    await storage.checkpointStore.set(
      `${RESEAL_PREFIX}lease`,
      clock.now().getTime() + LEASE_MS - 1,
    );
    expect(await reseal.sweep(clock.now())).toBe(0);
    expect((await reseal.status())?.step).toBe("events");
    await reseal.release();
  });

  it("leaves alone what a forgetting or a redaction rewrote since a batch was listed", async () => {
    const { storage, sealed, begun, sweepUntil, logger } = await setUp();
    const email = await sealed("ana", "ana@x");
    await storage.scheduler.schedule({
      dedupeKey: "gone",
      command: { type: "Mail", payload: { email }, aggregateId: "ana" },
      executeAt: new Date(START.getTime() + DAY),
      scheduledAt: START,
      context: testContext,
    });
    await storage.deadLetterStore.add({ ...testDeadLetter("gone"), payload: { email } });
    await begun();
    const transact = storage.transact.bind(storage);
    vi.spyOn(storage, "transact").mockImplementation(
      async <T>(work: (tx: StorageTransaction) => Promise<T>) => {
        await storage.scheduler.cancel("gone");
        await storage.deadLetterStore.remove("gone");
        return transact(work);
      },
    );
    await sweepUntil("failures");
    expect(await storage.scheduler.get("gone")).toBeNull();
    expect(await storage.deadLetterStore.get("gone")).toBeNull();
    expect(logger.logged.filter(({ level }) => level === "error")).toEqual([]);
  });
});
