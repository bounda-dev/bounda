import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { StoredPerson } from "../../adapter/storage/person-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { memory } from "../../memory/index.ts";
import { createKeptPersonStore } from "../../memory/person-store.ts";
import { tracer } from "../telemetry.ts";
import { createRecordingLogger } from "../test-support.ts";
import { forgetPersonalData } from "./forget.ts";
import { HOLD_MAX_MS, HOLD_MS } from "./hold.ts";
import { restrictProcessing } from "./restriction.ts";
import {
  createRetentionSubscriber,
  createRetentionSweep,
  RETENTION_SUBSCRIBER,
  RETENTION_SWEEP_LIMIT,
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

const forgotten = (position: number, person: string) =>
  event(position, { aggregateType: "bounda", type: "PersonalDataForgotten", person });

const restricted = (position: number, person: string) =>
  event(position, { aggregateType: "bounda", type: "ProcessingRestricted", person });

const day = (position: number): string =>
  new Date(Date.UTC(2026, 0, 1) + position * DAY).toISOString();

describe("createRetentionSubscriber", () => {
  it("records each person's last activity and last forgetting, once per batch", async () => {
    const { store } = createKeptPersonStore();
    const writes: string[] = [];
    const subscriber = createRetentionSubscriber({
      persons: {
        ...store,
        record: async (recorded) => {
          writes.push(recorded.person);
          await store.record(recorded);
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
      ],
      span,
    );
    expect(done).toBe(8);
    expect(writes.sort()).toEqual(["c-1", "c-2", "c-4"]);
    expect(await store.get("c-1")).toEqual({
      person: "c-1",
      restrictedSince: null,
      lastActiveAt: day(3),
      forgottenAt: null,
      hold: null,
    });
    expect(await store.get("c-2")).toMatchObject({ lastActiveAt: day(2), forgottenAt: day(4) });
    expect(await store.get("c-3")).toBeNull();
    expect(await store.get("c-4")).toMatchObject({ lastActiveAt: null, forgottenAt: day(7) });
  });

  it("clears a forgetting with the activity after it, and keeps the activity before it", async () => {
    const { store } = createKeptPersonStore();
    const subscriber = createRetentionSubscriber({ persons: store });
    await subscriber.process([activity(1, "c-1"), forgotten(2, "c-1")], span);
    expect(await store.get("c-1")).toMatchObject({ lastActiveAt: day(1), forgottenAt: day(2) });
    await subscriber.process([forgotten(3, "c-1"), activity(4, "c-1")], span);
    expect(await store.get("c-1")).toMatchObject({ lastActiveAt: day(4), forgottenAt: null });
  });

  it("leaves the same rows when its events are delivered again, or from the start", async () => {
    const events = [activity(1, "c-1"), forgotten(2, "c-1"), activity(3, "c-2")];
    const { store } = createKeptPersonStore();
    const subscriber = createRetentionSubscriber({ persons: store });
    await subscriber.process(events.slice(0, 2), span);
    await subscriber.process(events.slice(2), span);
    const rows = async (): Promise<readonly (StoredPerson | null)[]> =>
      Promise.all(["c-1", "c-2"].map((person) => store.get(person)));
    const before = await rows();
    await subscriber.process(events, span);
    await subscriber.process(events.slice(0, 1), span);
    expect(await rows()).toEqual(before);

    const rebuilt = createKeptPersonStore().store;
    await createRetentionSubscriber({ persons: rebuilt }).process(events, span);
    expect(await Promise.all(["c-1", "c-2"].map((person) => rebuilt.get(person)))).toEqual(before);
  });
});

const setUp = async (storage?: Storage) => {
  const live = storage ?? (await memory().createStorage());
  const clock = createFixedClock(new Date(day(0)));
  const ids = createSequentialIdGenerator();
  const { logger, entries } = createRecordingLogger();
  const sweepOver = (storage: Storage) =>
    createRetentionSweep({
      storage,
      retentionMs: 30 * DAY,
      ids,
      clock,
      logger,
      concurrencyRetries: 1,
      batchSize: 2,
    });
  const sweep = sweepOver(live);
  const subscriber = createRetentionSubscriber({ persons: live.persons });
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
        hadKey: false,
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
    const { sweep, record, touch, forgottenFor, advance, clock, storage, ids, logger } =
      await setUp();
    for (const person of ["c-1", "c-2", "c-3", "c-4"]) await touch(person);
    await record();
    advance(31);
    await touch("c-1");
    await forgetPersonalData({
      storage,
      ids,
      clock,
      logger,
      concurrencyRetries: 0,
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
    const { sweep, record, touch, forgottenFor, advance, clock, storage, ids, logger } =
      await setUp();
    const other = createRetentionSweep({
      storage,
      retentionMs: 30 * DAY,
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
              remove: async (person) => {
                attempts.push(person);
                if (person === "c-1") throw new Error("disk full");
                return transaction.personalKeys.remove(person);
              },
            },
          }),
        ),
    });
    const failedAt = Date.parse(day(32));
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
      message: "person past the retention could not be forgotten",
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
      message: "persons past the retention could not be listed",
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
      message: "person past the retention could not be held",
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
      retentionMs: 30 * DAY,
      ids: createSequentialIdGenerator(),
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
    const longer = createRetentionSweep({
      storage,
      retentionMs: 60 * DAY,
      ids: createSequentialIdGenerator(),
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
});
