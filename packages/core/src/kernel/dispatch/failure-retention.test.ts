import { describe, expect, it } from "vitest";
import type { NewSubscriberFailure } from "../../adapter/storage/subscriber-failure-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { memory } from "../../memory/index.ts";
import { HOLD_MS } from "../personal-data/hold.ts";
import { createRecordingLogger } from "../test-support.ts";
import { createSubscriberFailureRetention, HELD_FAILURE_RECHECK_MS } from "./failure-retention.ts";

const DAY = 86_400_000;
const start = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number): Date => new Date(start.getTime() + ms);

const failure = (
  subscriber: string,
  at: Date,
  overrides: Partial<NewSubscriberFailure> = {},
): NewSubscriberFailure => ({
  subscriber,
  position: 3,
  eventId: "e-3",
  eventType: "OrderPlaced",
  person: null,
  errorName: "Error",
  errorMessage: "boom",
  failedAt: at.toISOString(),
  ...overrides,
});

const setUp = async (subscribers: readonly string[] = ["projection:orders", "policies"]) => {
  const { subscriberFailures: store, persons } = await memory().createStorage();
  const clock = createFixedClock(start);
  const { logger, entries: logs } = createRecordingLogger();
  const retention = createSubscriberFailureRetention({
    store,
    persons,
    subscribers,
    retentionMs: 7 * DAY,
    clock,
    logger,
  });
  const fail = (subscriber: string, at: Date, overrides: Partial<NewSubscriberFailure> = {}) =>
    store.record(failure(subscriber, at, overrides));
  const resolved = async (
    subscriber: string,
    at: Date,
    overrides: Partial<NewSubscriberFailure> = {},
  ) => {
    await fail(subscriber, start, overrides);
    await store.resolve(subscriber, at);
  };
  const restrict = (person: string) =>
    persons.restrict(person, { ground: "legal-claims", categories: null, since: start });
  return { store, persons, clock, logs, retention, fail, resolved, restrict };
};

const subscribersOf = async (store: { list(): Promise<readonly { subscriber: string }[]> }) =>
  (await store.list()).map(({ subscriber }) => subscriber);

describe("the retention of subscriber failures", () => {
  it("names no time and purges nothing while every failure is of a subscriber still stuck on it", async () => {
    const { store, retention, fail } = await setUp();
    await fail("projection:orders", start);
    expect(await retention.nextDueAt()).toBeNull();
    expect(await retention.sweep(later(365 * DAY))).toBe(0);
    expect(await subscribersOf(store)).toEqual(["projection:orders"]);
    expect(await retention.status()).toEqual({ retentionMs: 7 * DAY, nextDueAt: null, held: 0 });
  });

  it("purges a resolved failure once the retention has passed since it was resolved", async () => {
    const { store, logs, retention, resolved } = await setUp();
    await resolved("projection:orders", later(DAY));
    await resolved("policies", later(2 * DAY));
    expect(await retention.nextDueAt()).toEqual(later(8 * DAY));
    expect(await retention.status()).toEqual({
      retentionMs: 7 * DAY,
      nextDueAt: later(8 * DAY).toISOString(),
      held: 0,
    });
    expect(await retention.sweep(later(8 * DAY - 1))).toBe(0);
    expect(await retention.sweep(later(8 * DAY))).toBe(1);
    expect(await subscribersOf(store)).toEqual(["policies"]);
    expect(logs).toEqual([
      {
        level: "debug",
        message: "subscriber failures past the retention purged",
        fields: { purged: 1 },
      },
    ]);
    expect(await retention.nextDueAt()).toEqual(later(9 * DAY));
    expect(await retention.sweep(later(30 * DAY))).toBe(1);
    expect(await retention.nextDueAt()).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("purges the failure of a subscriber the app no longer runs a retention after it last failed", async () => {
    const { store, retention, fail } = await setUp();
    await fail("projection:gone", later(DAY));
    await fail("projection:gone", later(2 * DAY));
    await fail("projection:orders", start);
    expect(await retention.nextDueAt()).toEqual(later(9 * DAY));
    expect(await retention.sweep(later(9 * DAY - 1))).toBe(0);
    expect(await retention.sweep(later(9 * DAY))).toBe(1);
    expect(await subscribersOf(store)).toEqual(["projection:orders"]);
  });

  it("names the time a failure is due as now once it is past, and the status says so too", async () => {
    const { clock, retention, resolved } = await setUp();
    await resolved("policies", start);
    clock.set(later(10 * DAY));
    expect(await retention.nextDueAt()).toEqual(later(10 * DAY));
    expect((await retention.status()).nextDueAt).toBe(later(10 * DAY).toISOString());
  });

  it("removes nothing a subscriber recorded or resolved again since the sweep read it", async () => {
    const { store, retention, resolved, fail } = await setUp();
    await resolved("policies", start);
    const remove = store.remove;
    store.remove = async (read, persons) => {
      await fail("policies", later(7 * DAY));
      return remove(read, persons);
    };
    expect(await retention.sweep(later(7 * DAY))).toBe(0);
    expect(await store.get("policies")).toMatchObject({ resolvedAt: null, attempts: 1 });
  });

  it("keeps a failure whose person is restricted while the sweep removes it, and reads it again next pass", async () => {
    const { clock, store, retention, resolved, restrict, logs } = await setUp();
    await resolved("policies", start, { person: "c-1", readPersons: ["c-2"] });
    const remove = store.remove;
    const told: (readonly string[])[] = [];
    store.remove = async (read, persons) => {
      told.push(persons);
      await restrict("c-2");
      return remove(read, persons);
    };
    const due = later(7 * DAY);
    expect(await retention.sweep(due)).toBe(0);
    expect(told).toEqual([["c-1", "c-2"]]);
    expect(await store.get("policies")).not.toBeNull();
    const list = store.list;
    let reads = 0;
    store.list = () => {
      reads += 1;
      return list();
    };
    expect(await retention.sweep(new Date(due.getTime() + 1))).toBe(0);
    expect(reads).toBe(1);
    clock.set(due);
    expect(await retention.status()).toMatchObject({ held: 1 });
    expect(logs).toEqual([]);
  });

  it("keeps a failure past the retention while a person its text is sealed under is restricted", async () => {
    const { store, persons, clock, retention, resolved, restrict } = await setUp();
    await resolved("projection:orders", start, { person: "c-1" });
    await resolved("policies", start, { person: "c-2", readPersons: ["c-3"] });
    await restrict("c-1");
    await restrict("c-3");
    const due = later(7 * DAY);
    clock.set(due);
    expect(await retention.sweep(due)).toBe(0);
    expect(await subscribersOf(store)).toEqual(["policies", "projection:orders"]);
    expect(await retention.status()).toEqual({ retentionMs: 7 * DAY, nextDueAt: null, held: 2 });
    await persons.unrestrict("c-3", { categories: null });
    // Lifted elsewhere: this instance reads the held failures again a while later.
    expect(await retention.sweep(new Date(due.getTime() + HELD_FAILURE_RECHECK_MS - 1))).toBe(0);
    expect(await retention.sweep(new Date(due.getTime() + HELD_FAILURE_RECHECK_MS))).toBe(1);
    expect(await subscribersOf(store)).toEqual(["projection:orders"]);
  });

  it("wakes a host only to read a held failure again, never while the sweep would not read it", async () => {
    const { clock, retention, resolved, restrict, persons } = await setUp();
    await resolved("projection:orders", start, { person: "c-1" });
    await restrict("c-1");
    const due = later(7 * DAY);
    clock.set(due);
    expect(await retention.nextDueAt()).toEqual(new Date(due.getTime() + HELD_FAILURE_RECHECK_MS));
    expect(await retention.sweep(due)).toBe(0);
    await persons.unrestrict("c-1", { categories: null });
    expect(await retention.nextDueAt()).toEqual(new Date(due.getTime() + HELD_FAILURE_RECHECK_MS));
    clock.set(new Date(due.getTime() + HELD_FAILURE_RECHECK_MS));
    expect(await retention.nextDueAt()).toEqual(clock.now());
  });

  it("names the earlier of a failure due and a held one read again", async () => {
    const { clock, retention, resolved, restrict } = await setUp();
    await resolved("projection:orders", start, { person: "c-1" });
    await resolved("policies", later(DAY));
    await restrict("c-1");
    clock.set(later(7 * DAY));
    expect(await retention.nextDueAt()).toEqual(later(7 * DAY + HELD_FAILURE_RECHECK_MS));
    clock.set(later(8 * DAY - HELD_FAILURE_RECHECK_MS + 1));
    expect(await retention.nextDueAt()).toEqual(later(8 * DAY));
  });

  it("reads the store again only once a failure can be due", async () => {
    const { store, retention, resolved } = await setUp();
    const list = store.list;
    let reads = 0;
    store.list = () => {
      reads += 1;
      return list();
    };
    await retention.sweep(start);
    expect(reads).toBe(1);
    await resolved("policies", later(DAY));
    await retention.sweep(later(7 * DAY - 1));
    expect(reads).toBe(1);
    expect(await retention.sweep(later(7 * DAY))).toBe(0);
    expect(reads).toBe(2);
    await retention.sweep(later(8 * DAY - 1));
    expect(reads).toBe(2);
    expect(await retention.sweep(later(8 * DAY))).toBe(1);
    expect(reads).toBe(3);
    await retention.sweep(later(15 * DAY - 1));
    expect(reads).toBe(3);
  });

  it("logs a store that fails, waits before trying again, and names that wait as when it is due", async () => {
    const { store, logs, retention, resolved } = await setUp();
    await resolved("policies", start);
    const remove = store.remove;
    let failures = 2;
    store.remove = (read, persons) => {
      if (failures === 0) return remove(read, persons);
      failures -= 1;
      return Promise.reject(new Error("database is down"));
    };
    const due = later(7 * DAY);
    expect(await retention.sweep(due)).toBe(0);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "subscriber failures past the retention could not be purged",
        fields: expect.objectContaining({ errorMessage: "database is down" }),
      }),
    );
    expect(await retention.nextDueAt()).toEqual(new Date(due.getTime() + HOLD_MS));
    expect(await retention.sweep(new Date(due.getTime() + HOLD_MS - 1))).toBe(0);
    const resumed = due.getTime() + HOLD_MS;
    expect(await retention.sweep(new Date(resumed))).toBe(0);
    expect(await retention.sweep(new Date(resumed + 2 * HOLD_MS))).toBe(1);
    expect(await retention.nextDueAt()).toBeNull();
  });

  it("names the end of the pause as when it is due while the store cannot be read, and logs it", async () => {
    const { clock, store, logs, retention, resolved } = await setUp();
    await resolved("policies", start);
    const { list } = store;
    store.list = () => Promise.reject(new Error("database is down"));
    expect(await retention.nextDueAt()).toEqual(later(HOLD_MS));
    expect(logs).toEqual([
      expect.objectContaining({
        level: "error",
        message: "subscriber failures past the retention could not be read",
        fields: expect.objectContaining({ errorMessage: "database is down" }),
      }),
    ]);
    expect(await retention.sweep(later(HOLD_MS - 1))).toBe(0);
    store.list = list;
    clock.set(later(7 * DAY));
    expect(await retention.nextDueAt()).toEqual(later(7 * DAY));
    expect(await retention.sweep(later(7 * DAY))).toBe(1);
  });

  it("reads again at once after a restore, though a pass had read it or a store paused it", async () => {
    const { store, retention, resolved } = await setUp();
    expect(await retention.sweep(start)).toBe(0);
    await store.record(failure("policies", later(-8 * DAY)));
    await store.resolve("policies", later(-8 * DAY));
    retention.restored();
    expect(await retention.sweep(start)).toBe(1);
    await resolved("projection:orders", later(-8 * DAY));
    const { list } = store;
    store.list = () => Promise.reject(new Error("down"));
    expect(await retention.sweep(later(1))).toBe(0);
    store.list = list;
    retention.restored();
    expect(await retention.sweep(later(2))).toBe(1);
  });

  it("purges a failure once whichever of two instances sweeps it first", async () => {
    const { store, persons, clock, retention, resolved } = await setUp();
    await resolved("policies", start);
    const other = createSubscriberFailureRetention({
      store,
      persons,
      subscribers: ["policies"],
      retentionMs: 7 * DAY,
      clock,
      logger: createRecordingLogger().logger,
    });
    const due = later(7 * DAY);
    expect(await Promise.all([retention.sweep(due), other.sweep(due)])).toEqual([1, 0]);
    expect(await store.list()).toEqual([]);
  });
});
