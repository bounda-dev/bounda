import { describe, expect, it } from "vitest";
import type { NewDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import { testDeadLetter } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { memory } from "../../memory/index.ts";
import { sealError } from "../personal-data/errors.ts";
import { HELD_RECHECK_MS } from "../personal-data/held-text.ts";
import { HOLD_MS } from "../personal-data/hold.ts";
import { LEASE_MS } from "../shared/lease.ts";
import { createRecordingLogger, keysOver } from "../test-support.ts";
import {
  createDeadLetterRetention,
  DEAD_LETTER_PURGE_LEASE,
  DEAD_LETTER_PURGE_LIMIT,
} from "./retention.ts";

const DAY = 86_400_000;
const start = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number): Date => new Date(start.getTime() + ms);

const setUp = async () => {
  const {
    deadLetterStore: store,
    checkpointStore: checkpoints,
    persons,
    personalKeys,
  } = await memory().createStorage();
  const clock = createFixedClock(start);
  const keys = keysOver(personalKeys);
  const { logger, entries: logs } = createRecordingLogger();
  // The app runs every handler but those of `gone`.
  const gone = new Set<string>();
  const create = () =>
    createDeadLetterRetention({
      store,
      checkpoints,
      persons,
      keys,
      handles: (kind, handler) => !gone.has(`${kind}:${handler}`),
      retentionMs: 7 * DAY,
      clock,
      logger,
    });
  const retention = create();
  const resolve = async (
    id: string,
    at: Date,
    status: "retried" | "discarded" = "retried",
    overrides: Partial<NewDeadLetter> = {},
  ) => {
    await store.add({ ...testDeadLetter(id), ...overrides });
    await store.updateStatus(id, status, at);
  };
  const restrict = (person: string) =>
    persons.restrict(person, { ground: "legal-claims", categories: null, since: start });
  // Text sealed under the person's key, as a failed handler's is.
  const sealed = async (person: string): Promise<Partial<NewDeadLetter>> => {
    await keys.create(person, "default");
    const { errorMessage } = await sealError({ error: new Error("boom"), person, keys });
    return { person, errorMessage };
  };
  const ids = async () => (await store.list()).map(({ id }) => id).sort();
  // Another instance over the same store.
  const other = create;
  return {
    store,
    checkpoints,
    persons,
    personalKeys,
    keys,
    clock,
    logs,
    retention,
    resolve,
    restrict,
    sealed,
    ids,
    gone,
    other,
  };
};

describe("the retention of dead letters", () => {
  it("names no time and purges nothing while no letter is resolved", async () => {
    const { store, retention } = await setUp();
    await store.add(testDeadLetter("failed"));
    expect(await retention.nextDueAt()).toBeNull();
    expect(await retention.sweep(later(365 * DAY))).toBe(0);
    expect(await store.get("failed")).not.toBeNull();
  });

  it("purges a resolved letter once the retention has passed since it was resolved", async () => {
    const { store, logs, retention, resolve } = await setUp();
    await resolve("retried", later(DAY));
    await resolve("discarded", later(2 * DAY), "discarded");
    expect(await retention.nextDueAt()).toEqual(later(8 * DAY));
    expect(await retention.sweep(later(8 * DAY - 1))).toBe(0);
    expect(await retention.sweep(later(8 * DAY))).toBe(1);
    expect(await store.get("retried")).toBeNull();
    expect(logs).toContainEqual({
      level: "debug",
      message: "resolved dead letters purged",
      fields: { purged: 1 },
    });
    expect(await retention.nextDueAt()).toEqual(later(9 * DAY));
    expect(await retention.sweep(later(30 * DAY))).toBe(1);
    expect(await retention.nextDueAt()).toBeNull();
  });

  it("purges at most a batch a pass, and leaves the rest due", async () => {
    const { store, retention, resolve } = await setUp();
    for (let at = 0; at <= DEAD_LETTER_PURGE_LIMIT; at += 1) await resolve(`l-${at}`, later(at));
    expect(await retention.sweep(later(8 * DAY))).toBe(DEAD_LETTER_PURGE_LIMIT);
    expect(await store.count()).toBe(1);
    expect(await retention.nextDueAt()).toEqual(later(7 * DAY + DEAD_LETTER_PURGE_LIMIT));
  });

  it("writes and logs nothing on a pass with nothing due", async () => {
    const { store, logs, retention, resolve } = await setUp();
    const purge = store.purge;
    let purges = 0;
    store.purge = (args) => {
      purges += 1;
      return purge(args);
    };
    await retention.sweep(later(DAY));
    await resolve("recent", start);
    await retention.sweep(later(DAY));
    expect(purges).toBe(0);
    expect(logs).toEqual([]);
  });

  it("reads the store again only once a letter can be due", async () => {
    const { store, retention, resolve } = await setUp();
    const firstResolvedAt = store.firstResolvedAt;
    let reads = 0;
    store.firstResolvedAt = () => {
      reads += 1;
      return firstResolvedAt();
    };
    await retention.sweep(start);
    await resolve("a", later(DAY));
    await retention.sweep(later(7 * DAY - 1));
    expect(reads).toBe(1);
    expect(await retention.sweep(later(7 * DAY))).toBe(0);
    expect(reads).toBe(2);
    await retention.sweep(later(8 * DAY - 1));
    expect(reads).toBe(2);
    expect(await retention.sweep(later(8 * DAY))).toBe(1);
    expect(await retention.sweep(later(8 * DAY))).toBe(0);
    expect(reads).toBe(4);
  });

  it("waits as long as the first time again once a pass reads the store", async () => {
    const { store, retention } = await setUp();
    const firstResolvedAt = store.firstResolvedAt;
    let failing = true;
    store.firstResolvedAt = () =>
      failing ? Promise.reject(new Error("database is down")) : firstResolvedAt();
    expect(await retention.sweep(start)).toBe(0);
    failing = false;
    expect(await retention.sweep(later(HOLD_MS))).toBe(0);
    failing = true;
    const again = later(HOLD_MS + 7 * DAY);
    expect(await retention.sweep(again)).toBe(0);
    failing = false;
    expect(await retention.nextDueAt()).toBeNull();
    store.firstResolvedAt = async () => new Date(0);
    expect(await retention.nextDueAt()).toEqual(new Date(again.getTime() + HOLD_MS));
  });

  it("logs a store that fails, waits before trying again, and names that wait as when it is due", async () => {
    const { store, logs, retention, resolve } = await setUp();
    await resolve("old", start);
    const purge = store.purge;
    let failures = 2;
    store.purge = (args) => {
      if (failures === 0) return purge(args);
      failures -= 1;
      return Promise.reject(new Error("database is down"));
    };
    const due = later(7 * DAY);
    expect(await retention.sweep(due)).toBe(0);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "resolved dead letters could not be purged",
        fields: expect.objectContaining({ errorMessage: "database is down" }),
      }),
    );
    expect(await retention.nextDueAt()).toEqual(new Date(due.getTime() + HOLD_MS));
    expect(await retention.sweep(new Date(due.getTime() + HOLD_MS - 1))).toBe(0);
    const resumed = due.getTime() + HOLD_MS;
    expect(await retention.sweep(new Date(resumed))).toBe(0);
    expect(await retention.nextDueAt()).toEqual(new Date(resumed + 2 * HOLD_MS));
    expect(await retention.sweep(new Date(resumed + 2 * HOLD_MS))).toBe(1);
    expect(await retention.nextDueAt()).toBeNull();
    await resolve("next", new Date(resumed));
    failures = 1;
    const next = resumed + 7 * DAY;
    expect(await retention.sweep(new Date(next))).toBe(0);
    expect(await retention.nextDueAt()).toEqual(new Date(next + HOLD_MS));
  });
});

describe("the retention of dead letters across instances", () => {
  it("purges each batch once while two instances run it: the one holding the lease", async () => {
    const { store, checkpoints, retention, resolve, other } = await setUp();
    for (let at = 0; at <= DEAD_LETTER_PURGE_LIMIT; at += 1) await resolve(`l-${at}`, later(at));
    const second = other();
    const due = later(8 * DAY);
    expect(await retention.sweep(due)).toBe(DEAD_LETTER_PURGE_LIMIT);
    expect(await second.sweep(due)).toBe(0);
    expect(await store.count()).toBe(1);
    expect(await checkpoints.get(DEAD_LETTER_PURGE_LEASE)).toBe(due.getTime() + LEASE_MS);
    expect(await second.nextDueAt()).toEqual(new Date(due.getTime() + LEASE_MS));
    await retention.release();
    expect(await second.sweep(due)).toBe(1);
  });

  it("hands the purge to another instance once its lease lapsed, and purges nothing more itself", async () => {
    const { store, retention, resolve, other } = await setUp();
    for (let at = 0; at < 2 * DEAD_LETTER_PURGE_LIMIT; at += 1) await resolve(`l-${at}`, later(at));
    const due = later(8 * DAY);
    expect(await retention.sweep(due)).toBe(DEAD_LETTER_PURGE_LIMIT);
    const lapsed = new Date(due.getTime() + LEASE_MS);
    const second = other();
    expect(await second.sweep(lapsed)).toBe(DEAD_LETTER_PURGE_LIMIT);
    await resolve("late", start);
    expect(await retention.sweep(new Date(lapsed.getTime() + 1))).toBe(0);
    expect(await store.count()).toBe(1);
  });

  it("purges again at once after a restore, though the store had paused it", async () => {
    const { store, retention, resolve } = await setUp();
    await resolve("a", later(-8 * DAY));
    const { firstResolvedAt } = store;
    store.firstResolvedAt = () => Promise.reject(new Error("down"));
    expect(await retention.sweep(start)).toBe(0);
    store.firstResolvedAt = firstResolvedAt;
    expect(await retention.sweep(start)).toBe(0);
    retention.restored();
    expect(await retention.sweep(start)).toBe(1);
  });

  it("reads the store again at once after a restore", async () => {
    const { store, retention, resolve } = await setUp();
    await retention.sweep(start);
    await resolve("a", later(-8 * DAY));
    expect(await retention.sweep(later(DAY))).toBe(0);
    retention.restored();
    expect(await retention.sweep(later(DAY))).toBe(1);
    expect(await store.count()).toBe(0);
  });

  it("says when the earliest resolved letter comes due", async () => {
    const { retention, resolve } = await setUp();
    expect(await retention.status()).toEqual({
      retentionMs: 7 * DAY,
      nextDueAt: null,
      held: 0,
      withoutHandler: 0,
    });
    await resolve("a", later(DAY));
    expect(await retention.status()).toEqual({
      retentionMs: 7 * DAY,
      nextDueAt: later(8 * DAY).toISOString(),
      held: 0,
      withoutHandler: 0,
    });
  });

  it("counts the failed letters no handler the app runs would retry, and none resolved", async () => {
    const { store, gone, retention, resolve } = await setUp();
    for (const id of ["a", "b"]) await store.add({ ...testDeadLetter(id), handler: "order.gone" });
    await store.add({ ...testDeadLetter("scheduled"), kind: "scheduled", handler: "order.p" });
    await store.add(testDeadLetter("running"));
    await resolve("settled", start, "discarded", { handler: "order.gone" });
    gone.add("policy:order.gone");
    gone.add("scheduled:order.p");
    expect(await retention.status()).toMatchObject({ withoutHandler: 3 });
  });

  it("reports the purge unreadable, and logs why, when its store cannot be read", async () => {
    const { store, logs, retention } = await setUp();
    store.failedByHandler = () => Promise.reject(new Error("database is down"));
    expect(await retention.status()).toEqual({ retentionMs: 7 * DAY, unreadable: true });
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "resolved dead letters could not be read",
        fields: expect.objectContaining({ errorMessage: "database is down" }),
      }),
    );
  });
});

describe("the retention of dead letters under a restriction", () => {
  it("keeps a letter past the retention while a person it names is restricted, and purges it once lifted", async () => {
    const { store, persons, clock, logs, retention, resolve, restrict, ids } = await setUp();
    await resolve("person", start, "retried", { person: "c-1" });
    await resolve("state", start, "retried", { person: null, statePerson: "c-2" });
    await resolve("read", start, "retried", { person: null, readPersons: ["c-3"] });
    await resolve("free", start, "retried", { person: "c-4" });
    for (const person of ["c-1", "c-2", "c-3"]) await restrict(person);
    const due = later(7 * DAY);
    clock.set(due);
    expect(await retention.status()).toEqual({
      retentionMs: 7 * DAY,
      nextDueAt: due.toISOString(),
      held: 3,
      withoutHandler: 0,
    });
    expect(await retention.sweep(due)).toBe(1);
    expect(await ids()).toEqual(["person", "read", "state"]);
    expect(await retention.status()).toEqual({
      retentionMs: 7 * DAY,
      nextDueAt: null,
      held: 3,
      withoutHandler: 0,
    });
    expect(await retention.sweep(new Date(due.getTime() + 1))).toBe(0);
    expect(await retention.nextDueAt()).toEqual(new Date(due.getTime() + HELD_RECHECK_MS));
    await persons.unrestrict("c-3", { categories: null });
    // Lifted elsewhere: this instance reads the held letters again a while later.
    expect(await retention.sweep(new Date(due.getTime() + HELD_RECHECK_MS - 1))).toBe(0);
    expect(await retention.sweep(new Date(due.getTime() + HELD_RECHECK_MS))).toBe(1);
    expect(await ids()).toEqual(["person", "state"]);
    expect(await store.count()).toBe(2);
    expect(logs.filter(({ level }) => level === "error")).toEqual([]);
  });

  it("keeps a letter for a person whose sealed fields it names, whatever its text", async () => {
    const { clock, retention, resolve, restrict, ids } = await setUp();
    const gone = { $personal: { person: "c-1", key: "gone", iv: "aXY=", data: "ZGF0YQ==" } };
    await resolve("scheduled", start, "discarded", {
      kind: "scheduled",
      person: "c-1",
      errorMessage: gone,
      persons: [{ person: "c-2", fingerprint: "f-2" }],
    });
    await restrict("c-1");
    await restrict("c-2");
    const due = later(7 * DAY);
    clock.set(due);
    expect(await retention.sweep(due)).toBe(0);
    expect(await ids()).toEqual(["scheduled"]);
    expect(await retention.status()).toMatchObject({ held: 1 });
  });

  it("keeps a letter for a restriction only while its text still opens", async () => {
    const { store, personalKeys, clock, logs, retention, resolve, restrict, sealed, ids } =
      await setUp();
    await resolve("kept", start, "retried", await sealed("c-1"));
    await resolve("forgotten", start, "retried", await sealed("c-2"));
    await restrict("c-1");
    await restrict("c-2");
    // c-2 forgotten while restricted: the restriction outlives the key, which nothing brings back.
    for (const { key } of await personalKeys.list("c-2")) {
      await personalKeys.remove("c-2", key.fingerprint);
    }
    const due = later(7 * DAY);
    clock.set(due);
    expect(await retention.status()).toEqual({
      retentionMs: 7 * DAY,
      nextDueAt: due.toISOString(),
      held: 1,
      withoutHandler: 0,
    });
    const removeHeld = store.removeHeld;
    const told: (readonly string[])[] = [];
    store.removeHeld = (letter, unlessRestricted) => {
      told.push(unlessRestricted);
      return removeHeld(letter, unlessRestricted);
    };
    expect(await retention.sweep(due)).toBe(1);
    expect(told).toEqual([[]]);
    expect(await ids()).toEqual(["kept"]);
    expect(logs).toContainEqual({
      level: "debug",
      message: "resolved dead letters purged",
      fields: { purged: 1 },
    });
    expect(await retention.status()).toMatchObject({ nextDueAt: null, held: 1 });
  });

  it("tells the store whose restriction still keeps a letter it releases", async () => {
    const { store, clock, retention, resolve, restrict } = await setUp();
    const gone = { $personal: { person: "c-1", key: "gone", iv: "aXY=", data: "ZGF0YQ==" } };
    await resolve("a", start, "retried", {
      kind: "scheduled",
      person: "c-1",
      errorMessage: gone,
      persons: [{ person: "c-3", fingerprint: "f-3" }],
    });
    await restrict("c-1");
    const due = later(7 * DAY);
    clock.set(due);
    const removeHeld = store.removeHeld;
    const told: (readonly string[])[] = [];
    store.removeHeld = async (letter, unlessRestricted) => {
      told.push(unlessRestricted);
      // Restricted between the read and the removal.
      await restrict("c-3");
      return removeHeld(letter, unlessRestricted);
    };
    expect(await retention.sweep(due)).toBe(0);
    expect(told).toEqual([["c-3"]]);
    expect(await store.count()).toBe(1);
  });

  it("keeps for its restriction a letter whose text cannot be read, and purges the others", async () => {
    const { keys, logs, retention, resolve, restrict, sealed, ids } = await setUp();
    await resolve("unreadable", start, "retried", await sealed("c-1"));
    await resolve("free", start);
    await restrict("c-1");
    const opened = keys.opened;
    keys.opened = (person, fingerprint) =>
      person === "c-1"
        ? Promise.reject(new Error("key store is down"))
        : opened(person, fingerprint);
    expect(await retention.sweep(later(7 * DAY))).toBe(1);
    expect(await ids()).toEqual(["unreadable"]);
    expect(logs.filter(({ level }) => level === "error")).toEqual([]);
  });

  it("opens no text of a letter none of whose persons is restricted", async () => {
    const { store, keys, retention, resolve, sealed } = await setUp();
    await resolve("a", start, "retried", await sealed("c-1"));
    keys.opened = () => Promise.reject(new Error("opened"));
    expect(await retention.sweep(later(7 * DAY))).toBe(1);
    expect(await store.count()).toBe(0);
  });

  it("reads the held letters a page a pass, and again only a while after the last page", async () => {
    const { store, personalKeys, clock, retention, resolve, restrict, sealed } = await setUp();
    const letter = await sealed("c-1");
    for (let at = 0; at <= DEAD_LETTER_PURGE_LIMIT; at += 1) {
      await resolve(`l-${String(at).padStart(3, "0")}`, later(at), "retried", letter);
    }
    await restrict("c-1");
    for (const { key } of await personalKeys.list("c-1")) {
      await personalKeys.remove("c-1", key.fingerprint);
    }
    const due = later(8 * DAY);
    clock.set(due);
    const listHeld = store.listHeld;
    const pages: (string | undefined)[] = [];
    store.listHeld = (args) => {
      pages.push(args.after);
      return listHeld(args);
    };
    expect(await retention.sweep(due)).toBe(DEAD_LETTER_PURGE_LIMIT);
    expect(await retention.nextDueAt()).toEqual(later(7 * DAY + DEAD_LETTER_PURGE_LIMIT));
    expect(await retention.sweep(due)).toBe(1);
    expect(pages).toEqual([undefined, "l-099"]);
    expect(await store.count()).toBe(0);
    expect(await retention.nextDueAt()).toBeNull();
  });

  it("starts the read of the held letters over once a pass found none due", async () => {
    const { store, persons, clock, retention, resolve, restrict, sealed } = await setUp();
    const letter = await sealed("c-1");
    for (let at = 0; at <= DEAD_LETTER_PURGE_LIMIT; at += 1) {
      await resolve(`l-${String(at).padStart(3, "0")}`, later(at), "retried", letter);
    }
    await restrict("c-1");
    const due = later(8 * DAY);
    clock.set(due);
    const listHeld = store.listHeld;
    const pages: (string | undefined)[] = [];
    store.listHeld = (args) => {
      pages.push(args.after);
      return listHeld(args);
    };
    expect(await retention.sweep(due)).toBe(0);
    pages.length = 0;
    expect(await retention.status()).toMatchObject({ held: DEAD_LETTER_PURGE_LIMIT + 1 });
    expect(pages).toEqual([undefined, "l-099"]);
    pages.length = 1;
    await persons.unrestrict("c-1", { categories: null });
    expect(await retention.sweep(due)).toBe(DEAD_LETTER_PURGE_LIMIT);
    await restrict("c-1");
    expect(await retention.sweep(due)).toBe(0);
    expect(pages).toEqual([undefined, undefined]);
  });

  it("reads a held letter that comes due meanwhile at the next read of the others, and none before", async () => {
    const { store, persons, clock, personalKeys, retention, resolve, restrict, sealed } =
      await setUp();
    await resolve("first", start, "retried", { person: "c-1" });
    await resolve("later", later(30 * 60_000), "retried", await sealed("c-2"));
    await restrict("c-1");
    await restrict("c-2");
    for (const { key } of await personalKeys.list("c-2")) {
      await personalKeys.remove("c-2", key.fingerprint);
    }
    const due = later(7 * DAY);
    clock.set(due);
    expect(await retention.sweep(due)).toBe(0);
    expect(await store.count()).toBe(2);
    await persons.unrestrict("c-1", { categories: null });
    clock.set(new Date(due.getTime() + 1));
    expect(await retention.sweep(clock.now())).toBe(1);
    const reread = new Date(due.getTime() + HELD_RECHECK_MS);
    expect(await retention.nextDueAt()).toEqual(reread);
    expect(await retention.sweep(new Date(reread.getTime() - 1))).toBe(0);
    expect(await store.count()).toBe(1);
    clock.set(reread);
    expect(await retention.sweep(reread)).toBe(1);
    expect(await store.count()).toBe(0);
  });

  it("names whichever comes first, a letter to purge or a held one to read", async () => {
    const { clock, retention, resolve, restrict } = await setUp();
    await resolve("free", later(2 * DAY));
    await resolve("held", later(DAY), "retried", { person: "c-1" });
    await restrict("c-1");
    expect(await retention.nextDueAt()).toEqual(later(8 * DAY));
    await resolve("sooner", later(DAY / 2));
    expect(await retention.nextDueAt()).toEqual(later(7 * DAY + DAY / 2));
    clock.set(later(8 * DAY));
    expect(await retention.status()).toMatchObject({
      nextDueAt: later(7 * DAY + DAY / 2).toISOString(),
    });
  });

  it("reads a letter it could not release again with the others a while later", async () => {
    const { store, personalKeys, clock, retention, resolve, restrict, sealed } = await setUp();
    await resolve("a", start, "retried", await sealed("c-1"));
    await restrict("c-1");
    for (const { key } of await personalKeys.list("c-1")) {
      await personalKeys.remove("c-1", key.fingerprint);
    }
    const due = later(7 * DAY);
    clock.set(due);
    const removeHeld = store.removeHeld;
    store.removeHeld = async () => false;
    expect(await retention.sweep(due)).toBe(0);
    expect(await retention.sweep(new Date(due.getTime() + 1))).toBe(0);
    store.removeHeld = removeHeld;
    expect(await retention.sweep(new Date(due.getTime() + HELD_RECHECK_MS - 1))).toBe(0);
    expect(await retention.sweep(new Date(due.getTime() + HELD_RECHECK_MS))).toBe(1);
  });

  it("names when a restricted letter comes due, and wakes a host only to read the held ones again", async () => {
    const { clock, logs, retention, resolve, restrict } = await setUp();
    await resolve("a", start, "retried", { person: "c-1" });
    await restrict("c-1");
    const due = later(7 * DAY);
    expect(await retention.nextDueAt()).toEqual(due);
    expect(await retention.status()).toEqual({
      retentionMs: 7 * DAY,
      nextDueAt: due.toISOString(),
      held: 0,
      withoutHandler: 0,
    });
    expect(await retention.sweep(start)).toBe(0);
    expect(await retention.sweep(new Date(due.getTime() - 1))).toBe(0);
    clock.set(due);
    expect(await retention.nextDueAt()).toEqual(due);
    expect(await retention.sweep(due)).toBe(0);
    expect(await retention.nextDueAt()).toEqual(new Date(due.getTime() + HELD_RECHECK_MS));
    expect(await retention.status()).toEqual({
      retentionMs: 7 * DAY,
      nextDueAt: null,
      held: 1,
      withoutHandler: 0,
    });
    expect(logs).toEqual([]);
  });

  it("names a pause as when it is due once the store cannot be read", async () => {
    const { store, logs, retention } = await setUp();
    store.firstHeldAt = () => Promise.reject(new Error("database is down"));
    expect(await retention.nextDueAt()).toEqual(new Date(start.getTime() + HOLD_MS));
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "resolved dead letters could not be read",
        fields: expect.objectContaining({ errorMessage: "database is down" }),
      }),
    );
    expect(await retention.sweep(start)).toBe(0);
  });

  it("reads the held letters again at once after a restore", async () => {
    const { persons, clock, retention, resolve, restrict } = await setUp();
    await resolve("a", start, "retried", { person: "c-1" });
    await restrict("c-1");
    const due = later(7 * DAY);
    clock.set(due);
    expect(await retention.sweep(due)).toBe(0);
    await persons.unrestrict("c-1", { categories: null });
    expect(await retention.sweep(new Date(due.getTime() + 1))).toBe(1);
  });
});
