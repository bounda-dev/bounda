import { describe, expect, it, vi } from "vitest";
import type { StorageTransaction } from "../../adapter/adapter.ts";
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
import {
  createPersonalDataReseal,
  RESEAL_PREFIX,
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
    const { reseal, storage, clock, sealed, begun, sweepUntil, logger } = await setUp();
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
