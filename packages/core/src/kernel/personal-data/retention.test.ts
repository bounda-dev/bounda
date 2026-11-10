import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { StoredPerson } from "../../adapter/storage/person-store.ts";
import { testPersonalKey } from "../../adapter/testing/fixtures.ts";
import { createFixedClock, type FixedClock } from "../../contracts/clock.ts";
import { retentionEnd } from "../../contracts/duration.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createSequentialIdGenerator, type IdGenerator } from "../../contracts/ids.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { createKeptPersonStore } from "../../memory/person-store.ts";
import { createKeptPersonalKeyStore } from "../../memory/personal-key-store.ts";
import type { PersonalDataModule } from "../../modules/personal-data.ts";
import { LEASE_MS } from "../shared/lease.ts";
import { tracer } from "../telemetry.ts";
import { createRecordingLogger, withoutLedger } from "../test-support.ts";
import { buildPersonalCategories, type PersonalCategories } from "./categories.ts";
import { forgetPersonalData } from "./forget.ts";
import { boundForgetLedger } from "./forget-ledger.ts";
import { HOLD_MAX_MS, HOLD_MS } from "./hold.ts";
import { createForgetIntentions } from "./intention.ts";
import { restrictProcessing } from "./restriction.ts";
import {
  createRetentionSubscriber,
  createRetentionSweep,
  RETENTION_LEASE,
  RETENTION_SUBSCRIBER,
  RETENTION_SWEEP_LIMIT,
  retains,
  retentionDueOf,
} from "./retention.ts";

const DAY = 86_400_000;
const span = tracer().startSpan("batch");

const event = (
  position: number,
  fields: Partial<StoredEvent> & Pick<StoredEvent, "aggregateType" | "type" | "person">,
): StoredEvent => ({
  id: `e-${position}`,
  aggregateId: fields.person ?? "x",
  version: 1,
  position,
  payload: {},
  timestamp: new Date(Date.UTC(2026, 0, 1) + position * DAY).toISOString(),
  metadata: { correlationId: "c", causationId: "c", depth: 0, schemaVersion: 1, system: false },
  ...fields,
});

const activity = (position: number, person: string | null) =>
  event(position, { aggregateType: "customer", type: "CustomerTouched", person });

const forgotten = (position: number, person: string, whole = true) =>
  event(position, {
    aggregateType: "bounda",
    type: "PersonalDataForgotten",
    person,
    payload: { personId: person, whole },
  });

const restricted = (position: number, person: string) =>
  event(position, { aggregateType: "bounda", type: "ProcessingRestricted", person });

const day = (position: number): string =>
  new Date(Date.UTC(2026, 0, 1) + position * DAY).toISOString();

const categoriesOf = (
  retentionMs: number | null,
  module?: PersonalDataModule,
): PersonalCategories =>
  buildPersonalCategories({
    module,
    retention: retentionMs === null ? null : { months: 0, ms: retentionMs },
  });

const noKeys = { touch: async () => undefined };

describe("createRetentionSubscriber", () => {
  it("records each person's last activity and last forgetting as a whole, once per batch", async () => {
    const { store } = createKeptPersonStore();
    const writes: string[] = [];
    const touches: (readonly [string, string])[] = [];
    const subscriber = createRetentionSubscriber({
      persons: {
        ...store,
        record: async (recorded) => {
          writes.push(recorded.person);
          await store.record(recorded);
        },
      },
      keys: {
        touch: async (person, lastActiveAt) => {
          touches.push([person, lastActiveAt]);
        },
      },
    });
    expect(subscriber).toMatchObject({ name: RETENTION_SUBSCRIBER, kind: "retention" });
    const done = await subscriber.process(
      [
        activity(1, "c-1"),
        activity(2, "c-2"),
        activity(3, "c-1"),
        forgotten(4, "c-2"),
        restricted(5, "c-3"),
        activity(6, null),
        forgotten(7, "c-4"),
        restricted(8, "c-1"),
        forgotten(9, "c-5", false),
      ],
      span,
    );
    expect(done).toBe(9);
    expect(writes.sort()).toEqual(["c-1", "c-2", "c-4"]);
    expect(touches.sort()).toEqual([
      ["c-1", day(3)],
      ["c-2", day(2)],
    ]);
    expect(await store.get("c-1")).toEqual({
      person: "c-1",
      restrictedSince: null,
      lastActiveAt: day(3),
      position: 3,
      forgottenAt: null,
      hold: null,
    });
    expect(await store.get("c-2")).toMatchObject({ lastActiveAt: day(2), forgottenAt: day(4) });
    expect(await store.get("c-3")).toBeNull();
    expect(await store.get("c-4")).toMatchObject({ lastActiveAt: null, forgottenAt: day(7) });
    expect(await store.get("c-5")).toBeNull();
  });

  it("follows the last activity on each of the person's keys in force, never on one retained", async () => {
    const { store } = createKeptPersonStore();
    const keys = createKeptPersonalKeyStore({
      restricted: () => false,
      lastActiveAt: () => null,
    }).store;
    await keys.add("c-1", "default", testPersonalKey("1"));
    await keys.add("c-1", "invoices", testPersonalKey("2"));
    await keys.retain("c-1", "f-2", { since: day(0), lastActiveAt: day(0) });
    const subscriber = createRetentionSubscriber({ persons: store, keys });
    await subscriber.process([activity(1, "c-1"), activity(2, "c-1")], span);
    expect(
      (await keys.list("c-1")).map(({ category, lastActiveAt }) => [category, lastActiveAt]),
    ).toEqual([
      ["default", day(2)],
      ["invoices", day(0)],
    ]);
  });

  it("clears a forgetting with the activity after it, and keeps the activity before it", async () => {
    const { store } = createKeptPersonStore();
    const subscriber = createRetentionSubscriber({ persons: store, keys: noKeys });
    await subscriber.process([activity(1, "c-1"), forgotten(2, "c-1")], span);
    expect(await store.get("c-1")).toMatchObject({ lastActiveAt: day(1), forgottenAt: day(2) });
    await subscriber.process([forgotten(3, "c-1"), activity(4, "c-1")], span);
    expect(await store.get("c-1")).toMatchObject({ lastActiveAt: day(4), forgottenAt: null });
  });

  it("leaves the same rows when its events are delivered again, or from the start", async () => {
    const events = [activity(1, "c-1"), forgotten(2, "c-1"), activity(3, "c-2")];
    const { store } = createKeptPersonStore();
    const subscriber = createRetentionSubscriber({ persons: store, keys: noKeys });
    await subscriber.process(events.slice(0, 2), span);
    await subscriber.process(events.slice(2), span);
    const rows = async (): Promise<readonly (StoredPerson | null)[]> =>
      Promise.all(["c-1", "c-2"].map((person) => store.get(person)));
    const before = await rows();
    await subscriber.process(events, span);
    await subscriber.process(events.slice(0, 1), span);
    expect(await rows()).toEqual(before);

    const rebuilt = createKeptPersonStore().store;
    await createRetentionSubscriber({ persons: rebuilt, keys: noKeys }).process(events, span);
    expect(await Promise.all(["c-1", "c-2"].map((person) => rebuilt.get(person)))).toEqual(before);
  });
});

interface SetUpOptions {
  readonly retentionMs?: number | null;
  readonly module?: PersonalDataModule;
}

const setUp = async (storage?: Storage, { retentionMs = 30 * DAY, module }: SetUpOptions = {}) => {
  const live = storage ?? (await memory().createStorage());
  const clock = createFixedClock(new Date(day(0)));
  const ids = createSequentialIdGenerator();
  const { logger, entries } = createRecordingLogger();
  const categories = categoriesOf(retentionMs, module);
  const sweepOver = (storage: Storage) =>
    createRetentionSweep({
      storage,
      intentions: withoutLedger({ ids, clock }),
      categories,
      ids,
      clock,
      logger,
      concurrencyRetries: 1,
      batchSize: 2,
    });
  const sweep = sweepOver(live);
  const subscriber = createRetentionSubscriber({ persons: live.persons, keys: live.personalKeys });
  // What the dispatcher does: the batch, then the checkpoint past it.
  const record = async (): Promise<void> => {
    const through = await live.checkpointStore.get(RETENTION_SUBSCRIBER);
    const events = await live.eventStore.readAll({ afterPosition: through, limit: 1000 });
    await subscriber.process(events, span);
    const last = events[events.length - 1];
    if (last !== undefined) await live.checkpointStore.set(RETENTION_SUBSCRIBER, last.position);
  };
  const touch = async (person: string): Promise<void> => {
    const { version } = await live.eventStore.load({
      aggregateType: "customer",
      aggregateId: person,
      fromVersion: Number.MAX_SAFE_INTEGER,
    });
    await live.eventStore.append({
      aggregateType: "customer",
      aggregateId: person,
      expectedVersion: version,
      events: [
        {
          id: ids.next(),
          aggregateType: "customer",
          aggregateId: person,
          version: version + 1,
          type: "CustomerTouched",
          payload: {},
          timestamp: clock.now().toISOString(),
          metadata: {
            correlationId: "c",
            causationId: "c",
            depth: 0,
            schemaVersion: 1,
            system: false,
          },
          person,
        },
      ],
    });
  };
  const forgettings = async (): Promise<readonly StoredEvent[]> =>
    (await live.eventStore.readAll({ afterPosition: 0, limit: 1000 })).filter(
      (stored) => stored.type === "PersonalDataForgotten",
    );
  const forgottenFor = async (): Promise<readonly (readonly [string, unknown])[]> =>
    (await live.eventStore.readAll({ afterPosition: 0, limit: 1000 }))
      .filter((stored) => stored.type === "PersonalDataForgotten")
      .map((stored) => [stored.aggregateId, (stored.payload as { reason: unknown }).reason]);
  const advance = (days: number): void => {
    clock.set(new Date(clock.now().getTime() + days * DAY));
  };
  return {
    storage: live,
    clock,
    ids,
    logger,
    entries,
    categories,
    forgettings,
    sweep,
    sweepOver,
    record,
    touch,
    forgottenFor,
    advance,
  };
};

// A store whose forget fails, for whoever sweeps through it, while `failing` says so.
const failingForgets = (live: Storage, failing: () => boolean): Storage => ({
  ...live,
  transact: async (work) => {
    if (failing()) throw new Error("disk full");
    return live.transact(work);
  },
});

describe("createRetentionSweep", () => {
  it("forgets the persons idle past the retention, with reason retention, and no one else", async () => {
    const { sweep, record, touch, forgottenFor, advance, clock, entries, storage } = await setUp();
    await touch("c-1");
    advance(10);
    await touch("c-2");
    await record();
    expect(await sweep.nextDueAt()).toEqual(new Date(Date.parse(day(30))));
    advance(20);
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect(await forgottenFor()).toEqual([["c-1", "retention"]]);
    const [event] = (await storage.eventStore.readAll({ afterPosition: 2, limit: 10 })).filter(
      (stored) => stored.type === "PersonalDataForgotten",
    );
    expect(event?.metadata).toMatchObject({
      correlationId: event?.metadata.causationId,
      depth: 0,
      system: true,
    });
    expect(event?.metadata.correlationId).toEqual(expect.any(String));
    expect(entries).toContainEqual({
      level: "info",
      message: "personal data forgotten",
      fields: {
        personId: "c-1",
        reason: "retention",
        whole: true,
        categories: ["default"],
        retained: [],
        expired: [],
        destroyedKeys: 0,
        cancelledCommands: 0,
        removedDeadLetters: 0,
      },
    });
    await record();
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(await sweep.nextDueAt()).toEqual(new Date(Date.parse(day(40))));
    expect((await storage.persons.get("c-1"))?.forgottenAt).toBe(day(30));
  });

  it("forgets nobody whose activity or forgetting past the subscriber's checkpoint it has not recorded", async () => {
    const { sweep, record, touch, forgottenFor, advance, clock, storage, ids, logger, categories } =
      await setUp();
    for (const person of ["c-1", "c-2", "c-3", "c-4"]) await touch(person);
    await record();
    advance(31);
    await touch("c-1");
    await forgetPersonalData({
      storage,
      intentions: withoutLedger({ ids, clock }),
      ids,
      clock,
      logger,
      concurrencyRetries: 0,
      categories,
      batchSize: 2,
      personId: "c-2",
    });
    // Restrictions are not activity: a page of them, a batch long, reads on to the next.
    const restrictions = async (personId: string, times: number): Promise<void> => {
      for (let restriction = 0; restriction < times; restriction += 1) {
        await restrictProcessing({ storage, ids, clock, logger, concurrencyRetries: 0, personId });
        await storage.persons.unrestrict(personId);
      }
    };
    await restrictions("c-3", 2);
    await touch("c-3");
    await restrictions("c-4", 3);
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect(await forgottenFor()).toEqual([
      ["c-2", "requested"],
      ["c-4", "retention"],
    ]);
    await record();
    clock.set(new Date(clock.now().getTime() + HOLD_MS));
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(await forgottenFor()).toHaveLength(2);
  });

  it("forgets a person once when two instances sweep at the same time", async () => {
    const { sweep, record, touch, forgottenFor, advance, clock, storage, ids, logger, categories } =
      await setUp();
    const other = createRetentionSweep({
      storage,
      intentions: withoutLedger({ ids, clock }),
      categories,
      ids,
      clock,
      logger,
      concurrencyRetries: 1,
      batchSize: 2,
    });
    await touch("c-1");
    await record();
    advance(31);
    const forgotten = await Promise.all([sweep.sweep(clock.now()), other.sweep(clock.now())]);
    expect(forgotten.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await forgottenFor()).toEqual([["c-1", "retention"]]);
    expect((await storage.persons.get("c-1"))?.hold).toBeNull();
  });

  it("holds a person whose row is behind on their own, without backing off, and says so in nextDueAt", async () => {
    const { sweep, record, touch, forgottenFor, advance, clock } = await setUp();
    await touch("c-1");
    await record();
    advance(31);
    await touch("c-1");
    const skippedAt = clock.now().getTime();
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(await sweep.nextDueAt()).toEqual(new Date(skippedAt + HOLD_MS));
    clock.set(new Date(skippedAt + HOLD_MS));
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(await sweep.nextDueAt()).toEqual(new Date(skippedAt + 2 * HOLD_MS));
    await record();
    expect(await sweep.nextDueAt()).toEqual(new Date(skippedAt + 30 * DAY));
    clock.set(new Date(skippedAt + 2 * HOLD_MS));
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(await forgottenFor()).toEqual([]);
  });

  it("goes on with the next persons while the first one's forget keeps failing, backing off for it alone", async () => {
    const live = await memory().createStorage();
    const attempts: string[] = [];
    const { sweep, record, touch, forgottenFor, clock, entries } = await setUp({
      ...live,
      transact: (work) =>
        live.transact((transaction) =>
          work({
            ...transaction,
            personalKeys: {
              ...transaction.personalKeys,
              remove: async (person, fingerprint) => {
                attempts.push(person);
                if (person === "c-1") throw new Error("disk full");
                return transaction.personalKeys.remove(person, fingerprint);
              },
            },
          }),
        ),
    });
    const failedAt = Date.parse(day(32));
    for (const person of ["c-1", "c-2", "c-3"]) {
      await live.personalKeys.add(person, "default", testPersonalKey(person));
    }
    await touch("c-1");
    clock.set(new Date(day(1)));
    await touch("c-2");
    // Due between the first person's second and third tries.
    clock.set(new Date(Date.parse(day(2)) + 2 * HOLD_MS));
    await touch("c-3");
    await record();
    clock.set(new Date(failedAt));
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect(await forgottenFor()).toEqual([["c-2", "retention"]]);
    expect(entries.filter(({ level }) => level === "error")).toHaveLength(1);
    await record();
    expect(await sweep.nextDueAt()).toEqual(new Date(failedAt + HOLD_MS));
    clock.set(new Date(failedAt + HOLD_MS - 1));
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(attempts).toEqual(["c-1", "c-2"]);
    clock.set(new Date(failedAt + HOLD_MS));
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(await sweep.nextDueAt()).toEqual(new Date(failedAt + 2 * HOLD_MS));
    clock.set(new Date(failedAt + 2 * HOLD_MS));
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect(await forgottenFor()).toEqual([
      ["c-2", "retention"],
      ["c-3", "retention"],
    ]);
    await record();
    expect(await sweep.nextDueAt()).toEqual(new Date(failedAt + 3 * HOLD_MS));
    clock.set(new Date(failedAt + 3 * HOLD_MS));
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(attempts).toEqual(["c-1", "c-2", "c-1", "c-3", "c-1"]);
    expect(await sweep.nextDueAt()).toEqual(new Date(failedAt + 7 * HOLD_MS));
  });

  it("starts a person's back-off over once they are forgotten, or are no longer idle", async () => {
    const live = await memory().createStorage();
    let failing = true;
    const { sweep, record, touch, advance, clock } = await setUp(
      failingForgets(live, () => failing),
    );
    const failTwice = async (): Promise<void> => {
      await sweep.sweep(clock.now());
      clock.advance(HOLD_MS);
      await sweep.sweep(clock.now());
      expect(await sweep.nextDueAt()).toEqual(new Date(clock.now().getTime() + 2 * HOLD_MS));
    };
    await touch("c-1");
    await record();
    advance(31);
    await failTwice();
    failing = false;
    clock.advance(2 * HOLD_MS);
    expect(await sweep.sweep(clock.now())).toBe(1);
    await record();
    await touch("c-1");
    await record();
    advance(31);
    failing = true;
    await failTwice();
    await touch("c-1");
    await record();
    clock.advance(2 * HOLD_MS);
    await sweep.sweep(clock.now());
    advance(31);
    await sweep.sweep(clock.now());
    expect(await sweep.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MS));
  });

  it("backs off a person no longer than HOLD_MAX_MS, and forgets the hold once they are", async () => {
    const live = await memory().createStorage();
    let broken = true;
    const { sweep, record, touch, forgottenFor, advance, clock } = await setUp(
      failingForgets(live, () => broken),
    );
    await touch("c-1");
    await record();
    advance(31);
    for (let failure = 0; failure < 10; failure += 1) {
      await sweep.sweep(clock.now());
      const next = await sweep.nextDueAt();
      expect((next?.getTime() ?? 0) - clock.now().getTime()).toBeLessThanOrEqual(HOLD_MAX_MS);
      clock.set(next ?? clock.now());
    }
    await sweep.sweep(clock.now());
    expect(await sweep.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MAX_MS));
    broken = false;
    clock.advance(HOLD_MAX_MS);
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect(await forgottenFor()).toEqual([["c-1", "retention"]]);
    await record();
    expect(await sweep.nextDueAt()).toBeNull();
  });

  it("leaves alone a person restricted after the list was read", async () => {
    const live = await memory().createStorage();
    let restrictNext = true;
    const { sweep, record, touch, forgottenFor, advance, clock, storage, entries } = await setUp({
      ...live,
      persons: {
        ...live.persons,
        listIdle: async (args) => {
          const idle = await live.persons.listIdle(args);
          if (args.activeBefore !== undefined && restrictNext) {
            restrictNext = false;
            await live.persons.restrict("c-1", new Date());
          }
          return idle;
        },
      },
    });
    await touch("c-1");
    await record();
    advance(31);
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(await forgottenFor()).toEqual([]);
    expect((await storage.persons.get("c-1"))?.restrictedSince).not.toBeNull();
    expect(entries.filter(({ level }) => level === "error")).toEqual([]);
    await live.persons.unrestrict("c-1");
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect(await forgottenFor()).toEqual([["c-1", "retention"]]);
  });

  it("leaves alone a key whose person was restricted, or active again, after the list was read", async () => {
    const live = await memory().createStorage();
    let change: (() => Promise<void>) | undefined;
    const profile = { categories: { profile: { basis: "consent", retention: "30d" } } } as const;
    const { sweep, record, touch, advance, clock, forgettings, entries } = await setUp(
      {
        ...live,
        personalKeys: {
          ...live.personalKeys,
          listDue: async (args) => {
            const listed = await live.personalKeys.listDue(args);
            const next = change;
            change = undefined;
            await next?.();
            return listed;
          },
        },
      },
      { retentionMs: null, module: profile },
    );
    await live.personalKeys.add("c-1", "profile", testPersonalKey("1"));
    await touch("c-1");
    await record();
    advance(31);
    change = () => live.persons.restrict("c-1", clock.now()).then(() => undefined);
    expect(await sweep.sweep(clock.now())).toBe(0);
    await live.persons.unrestrict("c-1");
    change = () => live.personalKeys.touch("c-1", clock.now().toISOString());
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(await forgettings()).toEqual([]);
    expect(entries.filter(({ level }) => level === "error")).toEqual([]);
    expect((await live.personalKeys.list("c-1")).map(({ category }) => category)).toEqual([
      "profile",
    ]);
  });

  it("waits for activity it has not recorded of a key in force, never of one a forgetting kept", async () => {
    const live = await memory().createStorage();
    const legal = {
      categories: {
        invoices: { basis: "legal-obligation", retention: "30d" },
        profile: { basis: "consent", retention: "30d" },
      },
    } as const;
    const { sweep, record, touch, advance, clock, ids, logger, categories, storage } = await setUp(
      live,
      { retentionMs: null, module: legal },
    );
    await live.personalKeys.add("c-1", "profile", testPersonalKey("1"));
    await live.personalKeys.add("c-1", "invoices", testPersonalKey("2"));
    await touch("c-1");
    await record();
    advance(10);
    await live.personalKeys.retain("c-1", testPersonalKey("2").fingerprint, {
      since: clock.now().toISOString(),
      lastActiveAt: day(0),
    });
    advance(21);
    await touch("c-1");
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect((await storage.personalKeys.list("c-1")).map(({ category }) => category)).toEqual([
      "profile",
    ]);
  });

  it("leaves a kept key a legal obligation keeps again, or whose person was restricted, after the list", async () => {
    const live = await memory().createStorage();
    let change: (() => Promise<void>) | undefined;
    const { sweep, clock, forgettings, entries } = await setUp(
      {
        ...live,
        personalKeys: {
          ...live.personalKeys,
          listRetained: async (args) => {
            const listed = await live.personalKeys.listRetained(args);
            const next = change;
            change = undefined;
            await next?.();
            return listed;
          },
        },
      },
      { retentionMs: null, module: { categories: {} } },
    );
    await live.personalKeys.add("c-1", "orders", testPersonalKey("1"));
    await live.personalKeys.retain("c-1", testPersonalKey("1").fingerprint, {
      since: day(0),
      lastActiveAt: day(0),
    });
    change = () => live.persons.restrict("c-1", clock.now()).then(() => undefined);
    expect(await sweep.sweep(clock.now())).toBe(0);
    await live.persons.unrestrict("c-1");
    change = async () => {
      await live.personalKeys.remove("c-1", testPersonalKey("1").fingerprint);
    };
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(await forgettings()).toEqual([]);
    expect(entries.filter(({ level }) => level === "error")).toEqual([]);
  });

  it("holds a kept key it could not destroy, and names when the hold ends", async () => {
    const live = await memory().createStorage();
    const { sweep, clock, entries } = await setUp(
      {
        ...live,
        transact: () => Promise.reject(new Error("store down")),
      },
      { retentionMs: null, module: { categories: {} } },
    );
    await live.personalKeys.add("c-1", "orders", testPersonalKey("1"));
    await live.personalKeys.retain("c-1", testPersonalKey("1").fingerprint, {
      since: day(0),
      lastActiveAt: day(0),
    });
    expect(await sweep.nextDueAt()).toEqual(new Date(day(0)));
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "personal data past the retention could not be forgotten",
        fields: expect.objectContaining({ personId: "c-1", category: "orders" }),
      }),
    );
    const [held] = await live.personalKeys.listRetained({ except: [], limit: 1 });
    expect(held?.hold).not.toBeNull();
    expect(await sweep.nextDueAt()).toEqual(new Date(held?.hold?.until ?? ""));
  });

  it("logs a person it cannot forget and goes on with the next", async () => {
    const live = await memory().createStorage();
    let broken = true;
    const { sweep, record, touch, forgottenFor, advance, clock, entries } = await setUp({
      ...live,
      transact: async (work) => {
        if (broken) {
          broken = false;
          throw new Error("disk full");
        }
        return live.transact(work);
      },
    });
    await touch("c-1");
    await touch("c-2");
    await record();
    advance(31);
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect(await forgottenFor()).toEqual([["c-2", "retention"]]);
    expect(entries).toContainEqual({
      level: "error",
      message: "personal data past the retention could not be forgotten",
      fields: expect.objectContaining({ personId: "c-1", errorMessage: "disk full" }),
    });
    await record();
    expect(await sweep.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MS));
    expect(await sweep.sweep(clock.now())).toBe(0);
    clock.set(new Date(clock.now().getTime() + HOLD_MS));
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect(await forgottenFor()).toEqual([
      ["c-2", "retention"],
      ["c-1", "retention"],
    ]);
  });

  it("waits longer after each list it cannot read, and as long as the first again after a pass that found nobody due", async () => {
    const live = await memory().createStorage();
    let broken = true;
    let lists = 0;
    const { sweepOver, clock } = await setUp(live);
    const sweep = sweepOver({
      ...live,
      persons: {
        ...live.persons,
        listIdle: async (args) => {
          if (args.activeBefore === undefined) return live.persons.listIdle(args);
          lists += 1;
          if (broken) throw new Error("connection reset");
          return live.persons.listIdle(args);
        },
      },
    });
    const passAfter = async (milliseconds: number): Promise<number> => {
      clock.advance(milliseconds);
      const before = lists;
      await sweep.sweep(clock.now());
      return lists - before;
    };
    expect(await passAfter(0)).toBe(1);
    expect(await passAfter(HOLD_MS)).toBe(1);
    expect(await passAfter(2 * HOLD_MS - 1)).toBe(0);
    broken = false;
    expect(await passAfter(1)).toBe(1);
    broken = true;
    expect(await passAfter(0)).toBe(1);
    expect(await passAfter(HOLD_MS - 1)).toBe(0);
    expect(await passAfter(1)).toBe(1);
  });

  it("logs a list it cannot read, never rejecting, and tries again later", async () => {
    const live = await memory().createStorage();
    let broken = true;
    const { sweep, record, touch, forgottenFor, advance, clock, entries } = await setUp({
      ...live,
      persons: {
        ...live.persons,
        listIdle: async (args) => {
          if (broken && args.activeBefore !== undefined) {
            broken = false;
            throw new Error("connection reset");
          }
          return live.persons.listIdle(args);
        },
      },
    });
    await touch("c-1");
    await record();
    advance(31);
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(entries).toContainEqual({
      level: "error",
      message: "personal data past the retention could not be listed",
      fields: expect.objectContaining({ errorMessage: "connection reset" }),
    });
    expect(await sweep.sweep(clock.now())).toBe(0);
    clock.set(new Date(clock.now().getTime() + HOLD_MS));
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect(await forgottenFor()).toEqual([["c-1", "retention"]]);
  });

  it("forgets at most a sweep's limit in one pass, least recently active first", async () => {
    const { sweep, record, touch, forgottenFor, advance, clock } = await setUp();
    const persons = Array.from({ length: RETENTION_SWEEP_LIMIT + 1 }, (_, n) => `c-${n}`);
    for (const person of persons) {
      await touch(person);
      advance(0.0001);
    }
    await record();
    advance(31);
    expect(await sweep.sweep(clock.now())).toBe(RETENTION_SWEEP_LIMIT);
    expect((await forgottenFor()).map(([person]) => person)).toEqual(
      persons.slice(0, RETENTION_SWEEP_LIMIT),
    );
    await record();
    expect(await sweep.sweep(clock.now())).toBe(1);
  });

  it("holds a person on their row, so another instance skips them until the hold ends", async () => {
    const { storage, sweepOver, record, touch, forgottenFor, advance, clock } = await setUp();
    const failing = sweepOver(failingForgets(storage, () => true));
    const healthy = sweepOver(storage);
    await touch("c-1");
    await record();
    advance(31);
    const failedAt = clock.now().getTime();
    expect(await failing.sweep(clock.now())).toBe(0);
    // Stopped, as an instance gives its lease back when it stops.
    await failing.release();
    expect((await storage.persons.get("c-1"))?.hold).toEqual({
      until: new Date(failedAt + HOLD_MS).toISOString(),
      attempts: 1,
    });
    expect(await healthy.sweep(clock.now())).toBe(0);
    expect(await healthy.nextDueAt()).toEqual(new Date(failedAt + HOLD_MS));
    clock.set(new Date(failedAt + HOLD_MS - 1));
    expect(await healthy.sweep(clock.now())).toBe(0);
    expect(await forgottenFor()).toEqual([]);
    clock.set(new Date(failedAt + HOLD_MS));
    expect(await healthy.sweep(clock.now())).toBe(1);
    expect(await forgottenFor()).toEqual([["c-1", "retention"]]);
    expect(await storage.persons.get("c-1")).toMatchObject({
      forgottenAt: clock.now().toISOString(),
      hold: null,
    });
    expect(await healthy.nextDueAt()).toBeNull();
  });

  it("keeps a person's back-off through a restart, from the failures before it", async () => {
    const { storage, sweepOver, record, touch, advance, clock } = await setUp();
    const broken = failingForgets(storage, () => true);
    const before = sweepOver(broken);
    await touch("c-1");
    await record();
    advance(31);
    await before.sweep(clock.now());
    clock.advance(HOLD_MS);
    await before.sweep(clock.now());
    expect(await before.nextDueAt()).toEqual(new Date(clock.now().getTime() + 2 * HOLD_MS));
    await before.release();
    const restarted = sweepOver(broken);
    expect(await restarted.nextDueAt()).toEqual(new Date(clock.now().getTime() + 2 * HOLD_MS));
    expect(await restarted.sweep(clock.now())).toBe(0);
    clock.advance(2 * HOLD_MS);
    await restarted.sweep(clock.now());
    expect(await restarted.nextDueAt()).toEqual(new Date(clock.now().getTime() + 4 * HOLD_MS));
    expect((await storage.persons.get("c-1"))?.hold?.attempts).toBe(3);
  });

  it("writes no hold when a sweep forgets, and holds the whole sweep when a hold cannot be written", async () => {
    const live = await memory().createStorage();
    const holds: string[] = [];
    let broken = false;
    const { storage, sweepOver, record, touch, advance, clock, entries } = await setUp(live);
    const sweep = sweepOver({
      ...failingForgets(live, () => broken),
      persons: {
        ...live.persons,
        hold: async (person, lastActiveAt, hold) => {
          holds.push(person);
          if (broken) throw new Error("read-only");
          return live.persons.hold(person, lastActiveAt, hold);
        },
      },
    });
    await touch("c-1");
    await touch("c-2");
    await record();
    advance(31);
    expect(await sweep.sweep(clock.now())).toBe(2);
    expect(holds).toEqual([]);
    await touch("c-3");
    await record();
    advance(31);
    broken = true;
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(entries).toContainEqual({
      level: "error",
      message: "personal data past the retention could not be held",
      fields: expect.objectContaining({ personId: "c-3", errorMessage: "read-only" }),
    });
    expect((await storage.persons.get("c-3"))?.hold).toBeNull();
    expect(await sweep.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MS));
    // Still unable to keep a hold: the sweep waits twice as long.
    clock.advance(HOLD_MS - 1);
    expect(await sweep.sweep(clock.now())).toBe(0);
    clock.advance(1);
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(await sweep.nextDueAt()).toEqual(new Date(clock.now().getTime() + 2 * HOLD_MS));
    broken = false;
    clock.advance(2 * HOLD_MS);
    expect(await sweep.sweep(clock.now())).toBe(1);
    // A pass the store answered in full: the next failure waits as long as the first.
    await touch("c-4");
    await record();
    advance(31);
    broken = true;
    await sweep.sweep(clock.now());
    expect(await sweep.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MS));
  });

  it("tells whom it forgot once their forgetting is committed, and reads one row for nextDueAt while the first is free", async () => {
    const live = await memory().createStorage();
    let lists = 0;
    const { touch, record, advance, clock, sweepOver } = await setUp(live);
    const told: string[] = [];
    const toldIds = createSequentialIdGenerator();
    const sweep = createRetentionSweep({
      storage: {
        ...live,
        persons: {
          ...live.persons,
          listIdle: (args) => {
            lists += 1;
            return live.persons.listIdle(args);
          },
        },
      },
      intentions: withoutLedger({ ids: toldIds, clock }),
      categories: categoriesOf(30 * DAY),
      ids: toldIds,
      clock,
      logger: createRecordingLogger().logger,
      concurrencyRetries: 1,
      batchSize: 2,
      forgotten: (personId) => told.push(personId),
    });
    await touch("c-1");
    await touch("c-2");
    await record();
    expect(await sweep.nextDueAt()).toEqual(new Date(Date.parse(day(30))));
    expect(lists).toBe(1);
    await live.persons.hold("c-1", day(0), { until: day(40), attempts: 1 });
    lists = 0;
    expect(await sweep.nextDueAt()).toEqual(new Date(Date.parse(day(30))));
    expect(lists).toBe(2);
    // Once the hold is over, the first person alone answers again.
    clock.set(new Date(day(40)));
    lists = 0;
    expect(await sweep.nextDueAt()).toEqual(new Date(Date.parse(day(30))));
    expect(lists).toBe(1);
    advance(1);
    expect(await sweep.sweep(clock.now())).toBe(2);
    expect(told).toEqual(["c-1", "c-2"]);
    expect(await sweepOver(live).sweep(clock.now())).toBe(0);
  });

  it("names a held person's hold end in nextDueAt, then their deadline once it is over", async () => {
    const { storage, record, touch, clock, sweepOver } = await setUp();
    await touch("c-1");
    await record();
    const longerIds = createSequentialIdGenerator();
    const longer = createRetentionSweep({
      storage,
      intentions: withoutLedger({ ids: longerIds, clock }),
      categories: categoriesOf(60 * DAY),
      ids: longerIds,
      clock,
      logger: createRecordingLogger().logger,
      concurrencyRetries: 0,
      batchSize: 2,
    });
    const end = new Date(clock.now().getTime() + HOLD_MS);
    await storage.persons.hold("c-1", day(0), { until: end.toISOString(), attempts: 1 });
    expect(await longer.nextDueAt()).toEqual(end);
    expect(await sweepOver(storage).nextDueAt()).toEqual(end);
    clock.set(end);
    expect(await longer.sweep(clock.now())).toBe(0);
    expect(await longer.nextDueAt()).toEqual(new Date(Date.parse(day(60))));
  });

  it("has nothing due without a person active once and not forgotten since, and reads no checkpoint", async () => {
    const live = await memory().createStorage();
    const asked: string[] = [];
    const { sweepOver, clock } = await setUp(live);
    const sweep = sweepOver({
      ...live,
      checkpointStore: {
        ...live.checkpointStore,
        get: async (name) => {
          asked.push(name);
          return live.checkpointStore.get(name);
        },
      },
    });
    expect(await sweep.nextDueAt()).toBeNull();
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(asked).toEqual([]);
  });

  it("destroys only the key of a declared category idle past its retention, with no retention of the app", async () => {
    const { storage, sweep, record, touch, forgettings, advance, clock, entries } = await setUp(
      undefined,
      {
        retentionMs: null,
        module: { categories: { profile: { basis: "consent", retention: "30d" } } },
      },
    );
    await storage.personalKeys.add("c-1", "default", testPersonalKey("1"));
    await storage.personalKeys.add("c-1", "profile", testPersonalKey("2"));
    await touch("c-1");
    await record();
    expect(await sweep.nextDueAt()).toEqual(new Date(Date.parse(day(30))));
    advance(31);
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect((await storage.personalKeys.list("c-1")).map(({ category }) => category)).toEqual([
      "default",
    ]);
    const [event] = await forgettings();
    expect(event?.payload).toEqual({
      personId: "c-1",
      reason: "retention",
      whole: false,
      categories: ["profile"],
      retained: [],
      expired: [],
      fingerprints: ["f-2"],
      cancelledCommands: [],
      removedDeadLetters: [],
    });
    expect(entries).toContainEqual({
      level: "info",
      message: "personal data forgotten",
      fields: expect.objectContaining({ personId: "c-1", whole: false, destroyedKeys: 1 }),
    });
    await record();
    expect((await storage.persons.get("c-1"))?.forgottenAt).toBeNull();
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(await sweep.nextDueAt()).toBeNull();
  });

  it("counts a retention in calendar months to the very moment it ends, never a day early", async () => {
    const { storage, sweep, record, touch, clock } = await setUp(undefined, {
      retentionMs: null,
      module: { categories: { profile: { basis: "consent", retention: "1mo" } } },
    });
    await storage.personalKeys.add("c-1", "profile", testPersonalKey("2"));
    await touch("c-1");
    await record();
    const lastActiveAt = (await storage.personalKeys.find("c-1", testPersonalKey("2").fingerprint))
      ?.lastActiveAt;
    const ends = retentionEnd(Date.parse(lastActiveAt ?? ""), { months: 1, ms: 0 });
    expect(await sweep.nextDueAt()).toEqual(new Date(ends));
    clock.set(new Date(ends - 1));
    expect(await sweep.sweep(clock.now())).toBe(0);
    clock.set(new Date(ends));
    expect(await sweep.sweep(clock.now())).toBe(1);
  });

  it("destroys a key retained under a legal obligation once its retention runs out from the activity it froze", async () => {
    const { storage, sweep, record, touch, forgettings, advance, clock, ids, logger, categories } =
      await setUp(undefined, {
        retentionMs: null,
        module: { categories: { invoices: { basis: "legal-obligation", retention: "30d" } } },
      });
    await storage.personalKeys.add("c-1", "invoices", testPersonalKey("1"));
    await touch("c-1");
    await record();
    advance(10);
    await forgetPersonalData({
      storage,
      intentions: withoutLedger({ ids, clock }),
      ids,
      clock,
      logger,
      concurrencyRetries: 0,
      categories,
      batchSize: 2,
      personId: "c-1",
    });
    await touch("c-1");
    await record();
    expect(await storage.personalKeys.list("c-1")).toEqual([
      {
        category: "invoices",
        key: testPersonalKey("1"),
        retainedSince: day(10),
        lastActiveAt: day(0),
      },
    ]);
    expect(await sweep.nextDueAt()).toEqual(new Date(Date.parse(day(30))));
    advance(19);
    expect(await sweep.sweep(clock.now())).toBe(0);
    advance(1);
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect(await storage.personalKeys.list("c-1")).toEqual([]);
    expect((await forgettings()).map(({ payload }) => payload)).toEqual([
      expect.objectContaining({ reason: "requested", whole: true, retained: ["invoices"] }),
      expect.objectContaining({
        reason: "retention",
        whole: false,
        categories: [],
        retained: [],
        expired: ["invoices"],
      }),
    ]);
  });

  it("destroys at once what a forgetting kept once no legal obligation keeps its category", async () => {
    const live = await memory().createStorage();
    const legal = {
      categories: {
        invoices: { basis: "legal-obligation", retention: "6y" },
        orders: { basis: "legal-obligation", retention: "6y" },
      },
    } as const;
    const kept = await setUp(live, { retentionMs: null, module: legal });
    await live.personalKeys.add("c-1", "invoices", testPersonalKey("1"));
    await live.personalKeys.add("c-2", "orders", testPersonalKey("2"));
    await kept.touch("c-1");
    await kept.touch("c-2");
    await kept.record();
    for (const person of ["c-1", "c-2"]) {
      await forgetPersonalData({
        storage: live,
        intentions: withoutLedger({ ids: kept.ids, clock: kept.clock }),
        ids: kept.ids,
        clock: kept.clock,
        logger: kept.logger,
        concurrencyRetries: 0,
        categories: buildPersonalCategories({ module: legal, retention: null }),
        batchSize: 2,
        personId: person,
      });
    }
    expect(await kept.sweep.sweep(kept.clock.now())).toBe(0);
    expect(await kept.sweep.nextDueAt()).not.toEqual(kept.clock.now());

    const changed = await setUp(live, {
      retentionMs: null,
      module: { categories: { invoices: { basis: "contract", retention: "6y" } } },
    });
    expect(await changed.sweep.nextDueAt()).toEqual(new Date(day(0)));
    expect(await changed.sweep.sweep(changed.clock.now())).toBe(2);
    expect(await live.personalKeys.list("c-1")).toEqual([]);
    expect(await live.personalKeys.list("c-2")).toEqual([]);
    expect((await changed.forgettings()).map(({ payload }) => payload).slice(-2)).toEqual([
      expect.objectContaining({ reason: "retention", whole: false, expired: ["invoices"] }),
      expect.objectContaining({ reason: "retention", whole: false, expired: ["orders"] }),
    ]);
    expect(await changed.sweep.nextDueAt()).toBeNull();
  });

  it("holds a key it could not destroy on the key, so the person's other keys and row stay free", async () => {
    const live = await memory().createStorage();
    let failing = true;
    const { storage, sweep, record, touch, advance, clock } = await setUp(
      failingForgets(live, () => failing),
      { module: { categories: { profile: { basis: "consent", retention: "10d" } } } },
    );
    await storage.personalKeys.add("c-1", "profile", testPersonalKey("1"));
    await touch("c-1");
    await record();
    advance(11);
    const failedAt = clock.now().getTime();
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(await storage.personalKeys.listDue({ category: "profile", limit: 10 })).toEqual([
      expect.objectContaining({
        fingerprint: "f-1",
        hold: { until: new Date(failedAt + HOLD_MS).toISOString(), attempts: 1 },
      }),
    ]);
    expect((await storage.persons.get("c-1"))?.hold).toBeNull();
    expect(await sweep.nextDueAt()).toEqual(new Date(failedAt + HOLD_MS));
    failing = false;
    clock.set(new Date(failedAt + HOLD_MS));
    expect(await sweep.sweep(clock.now())).toBe(1);
    expect(await storage.personalKeys.list("c-1")).toEqual([]);
    expect(await sweep.nextDueAt()).toEqual(new Date(Date.parse(day(30))));
  });
});

describe("retains", () => {
  it("says whether the app's retention or any declared category forgets for inactivity", () => {
    expect(retains(categoriesOf(null))).toBe(false);
    expect(retains(categoriesOf(DAY))).toBe(true);
    expect(
      retains(
        categoriesOf(null, { categories: { profile: { basis: "consent", retention: "1d" } } }),
      ),
    ).toBe(true);
  });
});

describe("the retention and the forget ledger", () => {
  const recordingIntentions = (ids: IdGenerator, clock: FixedClock) => {
    const recorded: ForgetLedgerEntry[] = [];
    const intentions = createForgetIntentions({
      ledger: {
        store: boundForgetLedger({
          ledger: {
            readMark: async () => 0,
            raiseMark: async () => undefined,
            append: async (entries) => {
              recorded.push(...entries);
            },
            read: async () => [],
          },
          timeoutMs: 1_000,
          clock,
        }),
        strict: true,
      },
      ids,
      clock,
      logger: silentLogger,
    });
    return { intentions, recorded };
  };

  it("records the intention of each forgetting before it commits, and none for a person it skips", async () => {
    const { record, touch, advance, clock, storage, ids, logger } = await setUp();
    const { intentions, recorded } = recordingIntentions(ids, clock);
    const sweep = createRetentionSweep({
      storage,
      intentions,
      categories: categoriesOf(30 * DAY),
      ids,
      clock,
      logger,
      concurrencyRetries: 1,
      batchSize: 2,
    });
    await storage.personalKeys.add("c-1", "default", testPersonalKey("1"));
    await touch("c-1");
    await touch("c-2");
    await record();
    await storage.persons.restrict("c-2", new Date(day(0)));
    advance(31);
    expect(await sweep.sweep(clock.now())).toBe(1);
    const [forgetting] = (
      await storage.eventStore.readAll({ afterPosition: 0, limit: 100 })
    ).filter((event) => event.type === "PersonalDataForgotten");
    expect(recorded).toEqual([
      {
        personId: "c-1",
        categories: null,
        eventId: forgetting?.id,
        forgottenAt: forgetting?.timestamp,
        reason: "retention",
        fingerprints: ["f-1"],
      },
    ]);
  });

  it("says a person is due as a sweep would forget them now, by their row and what it has not recorded", async () => {
    const { record, touch, advance, clock, storage } = await setUp();
    const due = retentionDueOf({
      categories: categoriesOf(30 * DAY),
      batchSize: 2,
      checkpoints: storage.checkpointStore,
    });
    const isDue = (person: string) => due(storage, person, clock.now(), null);
    for (const person of ["c-1", "c-2", "c-3", "c-4"]) await touch(person);
    await record();
    expect(await isDue("c-1")).toBe(false);
    advance(30);
    expect(await isDue("c-1")).toBe(true);
    expect(await isDue("c-9")).toBe(false);
    await storage.persons.restrict("c-2", new Date(day(30)));
    expect(await isDue("c-2")).toBe(false);
    await touch("c-3");
    expect(await isDue("c-3")).toBe(false);
    await storage.persons.record({ person: "c-4", position: 99, forgottenAt: day(30) });
    expect(await isDue("c-4")).toBe(false);
  });

  it("says keys are due as their category's retention would forget them now, every one of them", async () => {
    const { record, touch, advance, clock, storage } = await setUp(undefined, {
      retentionMs: null,
      module: {
        categories: {
          profile: { basis: "consent", retention: "30d" },
          invoices: { basis: "legal-obligation", retention: "60d" },
        },
      },
    });
    const due = retentionDueOf({
      categories: categoriesOf(null, {
        categories: {
          profile: { basis: "consent", retention: "30d" },
          invoices: { basis: "legal-obligation", retention: "60d" },
        },
      }),
      batchSize: 2,
      checkpoints: storage.checkpointStore,
    });
    await storage.personalKeys.add("c-1", "profile", testPersonalKey("1"));
    await storage.personalKeys.add("c-1", "invoices", testPersonalKey("2"));
    await storage.personalKeys.add("c-1", "retired", testPersonalKey("3"));
    await touch("c-1");
    await record();
    advance(30);
    const keys = async (...categories: string[]) =>
      (await storage.personalKeys.list("c-1")).filter(({ category }) =>
        categories.includes(category),
      );
    const isDue = async (...categories: string[]) =>
      due(storage, "c-1", clock.now(), await keys(...categories));
    expect(await isDue("profile")).toBe(true);
    expect(await isDue("profile", "invoices")).toBe(false);
    expect(await isDue("retired")).toBe(false);
    expect(await due(storage, "c-1", clock.now(), null)).toBe(false);
    await storage.persons.restrict("c-1", new Date(day(30)));
    expect(await isDue("profile")).toBe(false);
  });

  // A sweep through a store that runs `meanwhile` once, between the list and the person's forget,
  // or before the forget's transaction.
  const racing = async (
    when: "listed" | "transaction",
    meanwhile: (storage: Storage) => Promise<void>,
  ) => {
    const setup = await setUp();
    const { storage, ids, clock, logger } = setup;
    let pending: ((storage: Storage) => Promise<void>) | undefined = meanwhile;
    const once = async () => {
      const step = pending;
      pending = undefined;
      await step?.(storage);
    };
    const raced: Storage = {
      ...storage,
      persons: {
        ...storage.persons,
        listIdle: async (args) => {
          const listed = await storage.persons.listIdle(args);
          if (when === "listed" && listed.length > 0) await once();
          return listed;
        },
      },
      transact: async (work) => {
        if (when === "transaction") await once();
        return storage.transact(work);
      },
    };
    const { intentions, recorded } = recordingIntentions(ids, clock);
    const sweep = createRetentionSweep({
      storage: raced,
      intentions,
      categories: categoriesOf(30 * DAY),
      ids,
      clock,
      logger,
      concurrencyRetries: 1,
      batchSize: 2,
    });
    await storage.personalKeys.add("c-1", "default", testPersonalKey("1"));
    await setup.touch("c-1");
    await setup.record();
    setup.advance(31);
    return { ...setup, sweep, recorded };
  };

  it("records no intention for a person restricted between the list and their forget", async () => {
    const { sweep, clock, recorded, forgottenFor } = await racing("listed", (storage) =>
      storage.persons.restrict("c-1", new Date(day(31))).then(() => undefined),
    );
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(recorded).toEqual([]);
    expect(await forgottenFor()).toEqual([]);
  });

  it("forgets nobody whose transaction finds them restricted after the intention, nor given a key since, and holds them", async () => {
    const restricted = await racing("transaction", (storage) =>
      storage.persons.restrict("c-1", new Date(day(31))).then(() => undefined),
    );
    expect(await restricted.sweep.sweep(restricted.clock.now())).toBe(0);
    expect(restricted.recorded).toHaveLength(1);
    expect(await restricted.forgottenFor()).toEqual([]);

    const rekeyed = await racing("transaction", async (storage) => {
      await storage.personalKeys.remove("c-1", "f-1");
      await storage.personalKeys.add("c-1", "default", testPersonalKey("2"));
    });
    expect(await rekeyed.sweep.sweep(rekeyed.clock.now())).toBe(0);
    expect(rekeyed.entries.filter(({ level }) => level === "error")).toEqual([]);
    expect(await rekeyed.forgottenFor()).toEqual([]);
    expect(await rekeyed.storage.personalKeys.get("c-1", "default")).toEqual(testPersonalKey("2"));
    const [row] = await rekeyed.storage.persons.listIdle({ limit: 1 });
    expect(row?.hold).not.toBeNull();
    expect(await rekeyed.sweep.sweep(rekeyed.clock.now())).toBe(0);
  });

  it("leaves a person a reconciliation forgot under the intention's id meanwhile", async () => {
    let intended = "";
    const { sweep, clock, recorded, forgottenFor, storage } = await racing(
      "transaction",
      async (store) => {
        intended = recorded[0]?.eventId ?? "";
        await store.eventStore.append({
          aggregateType: "bounda",
          aggregateId: "c-1",
          expectedVersion: 0,
          events: [
            {
              ...forgotten(99, "c-1"),
              aggregateId: "c-1",
              id: intended,
              payload: { personId: "c-1", reason: "retention" },
            },
          ],
        });
      },
    );
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect((await forgottenFor()).map(([person]) => person)).toEqual(["c-1"]);
    expect(intended).not.toBe("");
    expect(await storage.personalKeys.get("c-1", "default")).not.toBeNull();
  });

  it("says a person whose row never saw them active is not due", async () => {
    const { storage, clock } = await setUp();
    await storage.persons.record({ person: "c-5", position: 1, forgottenAt: null });
    const due = retentionDueOf({
      categories: categoriesOf(DAY),
      batchSize: 2,
      checkpoints: storage.checkpointStore,
    });
    expect(await due(storage, "c-5", new Date(clock.now().getTime() + 2 * DAY), null)).toBe(false);
  });

  it("records no intention for a person active since their row was recorded", async () => {
    const { sweep, clock, recorded, forgottenFor, touch } = await racing(
      "listed",
      async () => undefined,
    );
    await touch("c-1");
    expect(await sweep.sweep(clock.now())).toBe(0);
    expect(recorded).toEqual([]);
    expect(await forgottenFor()).toEqual([]);
  });
});

describe("the retention across instances", () => {
  // A store that runs `after` once each forget commits.
  const committing = (live: Storage, after: () => Promise<void>): Storage => ({
    ...live,
    transact: async (work) => {
      const result = await live.transact(work);
      await after();
      return result;
    },
  });

  const idle = async (persons: readonly string[]) => {
    const set = await setUp();
    for (const person of persons) await set.touch(person);
    await set.record();
    set.advance(31);
    return set;
  };

  it("forgets each person once while two instances sweep: the one holding the lease", async () => {
    const { storage, sweepOver, forgottenFor, clock } = await idle(["c-1", "c-2", "c-3"]);
    const one = sweepOver(storage);
    const other = sweepOver(storage);
    expect(await one.sweep(clock.now())).toBe(3);
    expect(await other.sweep(clock.now())).toBe(0);
    expect(await forgottenFor()).toEqual([
      ["c-1", "retention"],
      ["c-2", "retention"],
      ["c-3", "retention"],
    ]);
    expect(await storage.checkpointStore.get(RETENTION_LEASE)).toBe(
      clock.now().getTime() + LEASE_MS,
    );
  });

  it("leaves the persons to the instance holding the lease, and names when it lapses", async () => {
    const { storage, sweepOver, touch, record, advance, clock } = await idle(["c-1"]);
    const one = sweepOver(storage);
    const leased = clock.now().getTime() + LEASE_MS;
    expect(await one.sweep(clock.now())).toBe(1);
    advance(-31);
    await touch("c-2");
    await record();
    advance(31);
    let lists = 0;
    const other = sweepOver({
      ...storage,
      persons: {
        ...storage.persons,
        listIdle: (args) => {
          lists += 1;
          return storage.persons.listIdle(args);
        },
      },
    });
    expect(await other.sweep(clock.now())).toBe(0);
    expect(await other.sweep(clock.now())).toBe(0);
    expect(lists).toBe(1);
    expect(await other.nextDueAt()).toEqual(new Date(leased));
    await one.release();
    expect(await other.sweep(clock.now())).toBe(1);
  });

  it("hands the rest to another instance when its lease lapses mid-way, forgetting nobody twice", async () => {
    const { storage, sweepOver, forgottenFor, clock } = await idle(["c-1", "c-2", "c-3", "c-4"]);
    const other = sweepOver(storage);
    let commits = 0;
    let handedOver = 0;
    // After its second forget the instance stalls past its lease, and the other runs a pass.
    const one = sweepOver(
      committing(storage, async () => {
        commits += 1;
        if (commits !== 2) return;
        clock.set(new Date(clock.now().getTime() + LEASE_MS));
        handedOver = await other.sweep(clock.now());
      }),
    );
    expect(await one.sweep(clock.now())).toBe(2);
    expect(handedOver).toBe(2);
    expect((await forgottenFor()).map(([person]) => person)).toEqual(["c-1", "c-2", "c-3", "c-4"]);
  });

  it("clears the holds a restore brought back, on the instance that found it first", async () => {
    const { storage, sweepOver, clock } = await idle(["c-1"]);
    const hold = {
      until: new Date(clock.now().getTime() + HOLD_MAX_MS).toISOString(),
      attempts: 5,
    };
    await storage.persons.hold("c-1", day(0), hold);
    await sweepOver(storage).restored(false);
    expect((await storage.persons.get("c-1"))?.hold).toEqual(hold);
    const sweep = sweepOver(storage);
    expect(await sweep.sweep(clock.now())).toBe(0);
    await sweep.restored(true);
    expect((await storage.persons.get("c-1"))?.hold).toBeNull();
    expect(await sweep.nextDueAt()).toEqual(new Date(Date.parse(day(0)) + 30 * DAY));
    expect(await sweep.sweep(clock.now())).toBe(1);
  });

  it("sweeps again at once after a restore, though the store had paused it", async () => {
    const { storage, sweepOver, clock } = await idle(["c-1"]);
    let down = true;
    const sweep = sweepOver({
      ...storage,
      persons: {
        ...storage.persons,
        listIdle: (args) =>
          down ? Promise.reject(new Error("down")) : storage.persons.listIdle(args),
      },
    });
    expect(await sweep.sweep(clock.now())).toBe(0);
    down = false;
    expect(await sweep.sweep(clock.now())).toBe(0);
    await sweep.restored(false);
    expect(await sweep.sweep(clock.now())).toBe(1);
  });

  it("logs holds it could not clear after a restore, and goes on", async () => {
    const { storage, sweepOver, entries } = await idle([]);
    await sweepOver({
      ...storage,
      persons: {
        ...storage.persons,
        releaseHolds: () => Promise.reject(new Error("cannot write")),
      },
    }).restored(true);
    expect(entries).toContainEqual({
      level: "error",
      message: "the holds of personal data past the retention could not be cleared",
      fields: expect.objectContaining({ errorMessage: "cannot write" }),
    });
  });

  it("says, for each retention, how many are past it and when the next one comes due", async () => {
    const module: PersonalDataModule = {
      categories: {
        profile: { basis: "consent", retention: "10d" },
        invoices: { basis: "legal-obligation", retention: "6y" },
      },
    };
    const { storage, sweepOver, touch, record, advance, clock } = await setUp(undefined, {
      module,
    });
    const sweep = sweepOver(storage);
    const status = (
      app: readonly [number, string | null],
      profile: readonly [number, string | null],
      invoices: readonly [number, string | null],
      keptBeyond = 0,
    ) => ({
      categories: [
        { category: "default", retention: "30d", due: app[0], nextDueAt: app[1] },
        { category: "profile", retention: "10d", due: profile[0], nextDueAt: profile[1] },
        { category: "invoices", retention: "6y", due: invoices[0], nextDueAt: invoices[1] },
      ],
      keptBeyond,
    });
    expect(await sweep.status()).toEqual(status([0, null], [0, null], [0, null]));
    await storage.personalKeys.add("c-1", "profile", testPersonalKey("1"));
    await storage.personalKeys.add("c-1", "invoices", testPersonalKey("2"));
    await storage.personalKeys.add("c-3", "retired", testPersonalKey("3"));
    await storage.personalKeys.retain("c-3", "f-3", { since: day(0), lastActiveAt: day(0) });
    await touch("c-1");
    advance(1);
    await touch("c-2");
    await record();
    advance(29.5);
    expect(await sweep.status()).toEqual(
      status(
        [1, new Date(Date.parse(day(0)) + 30 * DAY).toISOString()],
        [1, new Date(Date.parse(day(0)) + 10 * DAY).toISOString()],
        [0, "2032-01-01T00:00:00.000Z"],
        1,
      ),
    );
    expect(clock.now().getTime()).toBe(Date.parse(day(30)) + DAY / 2);
  });
});
