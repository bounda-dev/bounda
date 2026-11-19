import { describe, expect, it } from "vitest";
import { memory } from "../memory/index.ts";
import { deferWrites } from "./deferred-writes.ts";
import type { KeyedPerson } from "./storage/personal-key-store.ts";
import {
  testKeyedPerson as held,
  testPersonalKey as stored,
  testAnswer,
  testCommand,
  testContext,
  testDeadLetter,
} from "./testing/fixtures.ts";

const now = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number): Date => new Date(now.getTime() + ms);
const record = (key: string, persons: readonly KeyedPerson[]) => ({
  key,
  answer: testAnswer(key),
  expiresAt: "2026-01-02T00:00:00.000Z",
  persons,
  now,
});

describe("deferWrites", () => {
  it("erases the answers it holds back for a person, and erases them on flush", async () => {
    const storage = await memory().createStorage();
    await storage.personalKeys.add("c-1", "default", stored("1"));
    await storage.personalKeys.add("c-2", "default", stored("2"));
    await storage.idempotencyStore.put(record("live", [held("c-1", "1")]));
    const { stores, flush } = deferWrites(storage);
    await stores.idempotencyStore.put(record("held", [held("c-1", "1")]));
    await stores.idempotencyStore.put(record("other", []));
    await stores.idempotencyStore.put(record("bo", [held("c-2", "2")]));
    await stores.idempotencyStore.put({
      ...record("aged", [held("c-1", "1")]),
      expiresAt: now.toISOString(),
    });
    await stores.idempotencyStore.put(record("another", [held("c-1", "1")]));
    expect(
      (await stores.idempotencyStore.listByPerson({ person: "c-1", now })).map(({ key }) => key),
    ).toEqual(["another", "held", "live"]);
    await stores.idempotencyStore.forget("c-1");
    const answerOf = async (key: string, of = stores) =>
      (await of.idempotencyStore.get({ key, now }))?.answer;
    expect(await answerOf("held")).toBeNull();
    expect(await answerOf("other")).toEqual(testAnswer("other"));
    expect(await answerOf("bo")).toEqual(testAnswer("bo"));
    expect(await answerOf("live", storage)).toEqual(testAnswer("live"));
    expect(
      (await stores.idempotencyStore.listByPerson({ person: "c-1", now })).map(({ key }) => key),
    ).toEqual(["live"]);
    await flush(storage);
    expect(await answerOf("live", storage)).toBeNull();
    expect(await answerOf("held", storage)).toBeNull();
    expect(await answerOf("other", storage)).toEqual(testAnswer("other"));
    expect(await answerOf("bo", storage)).toEqual(testAnswer("bo"));
  });

  it("pages what it holds back with the live store's records, by key", async () => {
    const storage = await memory().createStorage();
    await storage.personalKeys.add("c-1", "default", stored("1"));
    for (const key of ["a", "b", "c", "d"]) {
      await storage.idempotencyStore.put(record(key, [held("c-1", "1")]));
    }
    const { stores } = deferWrites(storage);
    await stores.idempotencyStore.put(record("a", []));
    await stores.idempotencyStore.put(record("b", []));
    await stores.idempotencyStore.put(record("bb", [held("c-1", "1")]));
    await stores.idempotencyStore.put(record("e", [held("c-1", "1")]));
    const keysOf = async (page: { readonly after?: string; readonly limit?: number }) =>
      (await stores.idempotencyStore.listByPerson({ person: "c-1", now, ...page })).map(
        ({ key }) => key,
      );
    expect(await keysOf({ limit: 2 })).toEqual(["bb", "c"]);
    expect(await keysOf({ limit: 1 })).toEqual(["bb"]);
    expect(await keysOf({ after: "bb", limit: 2 })).toEqual(["c", "d"]);
    expect(await keysOf({ after: "d", limit: 2 })).toEqual(["e"]);
    expect(await keysOf({})).toEqual(["bb", "c", "d", "e"]);
    // A short page of the live store ends nothing: what is held back after it follows.
    expect(await keysOf({ after: "c", limit: 3 })).toEqual(["d", "e"]);
    expect(await keysOf({ after: "bb", limit: 3 })).toEqual(["c", "d", "e"]);
    expect(await keysOf({ after: "e" })).toEqual([]);
    expect(await keysOf({ limit: 0 })).toEqual([]);
    expect(await keysOf({ limit: 3 })).toEqual(["bb", "c"]);
    // Held back under a key the live page ends on, it takes that record's place.
    await stores.idempotencyStore.put(record("d", [held("c-1", "1")]));
    expect(await keysOf({ after: "bb", limit: 2 })).toEqual(["c", "d"]);
  });

  it("lists and erases what it holds back and what the live store holds, filing it elsewhere on flush", async () => {
    const storage = await memory().createStorage();
    await storage.idempotencyStore.put(record("live", []));
    await storage.idempotencyStore.put(record("plain", []));
    const { stores, flush } = deferWrites(storage);
    await stores.idempotencyStore.put(record("held", []));
    expect((await stores.idempotencyStore.list({ now })).map(({ key }) => key)).toEqual([
      "held",
      "live",
      "plain",
    ]);
    expect(await stores.idempotencyStore.list({ now, limit: 1, offset: 1 })).toHaveLength(1);
    await stores.idempotencyStore.erase({ key: "live", now });
    await stores.idempotencyStore.erase({ key: "held", now });
    await stores.idempotencyStore.erase({ key: "plain", filed: "hmac", now });
    await stores.idempotencyStore.erase({ key: "none", now });
    for (const key of ["live", "held", "hmac"]) {
      expect((await stores.idempotencyStore.get({ key, now }))?.answer).toBeNull();
    }
    expect(await stores.idempotencyStore.get({ key: "plain", now })).toBeNull();
    expect((await storage.idempotencyStore.get({ key: "live", now }))?.answer).toEqual(
      testAnswer("live"),
    );
    await flush(storage);
    expect(
      (await storage.idempotencyStore.list({ now })).map(({ key, answer }) => [key, answer]),
    ).toEqual([
      ["held", null],
      ["hmac", null],
      ["live", null],
    ]);
  });

  it("lists past a key and reseals what it holds back while it holds what was read, and the live store on flush", async () => {
    const storage = await memory().createStorage();
    await storage.idempotencyStore.put(record("live", []));
    const { stores, flush } = deferWrites(storage);
    await stores.idempotencyStore.put(record("held", []));
    await stores.idempotencyStore.put(record("other", []));
    expect(
      (await stores.idempotencyStore.list({ now, after: "held" })).map(({ key }) => key),
    ).toEqual(["live", "other"]);
    const resealed = { $sealed: { salt: "s", data: "new" } };
    const persons = [held("c-1", "1")];
    await stores.idempotencyStore.reseal({
      key: "held",
      from: testAnswer("held"),
      answer: resealed,
      persons,
      now,
    });
    await stores.idempotencyStore.reseal({
      key: "other",
      from: testAnswer("stale"),
      answer: resealed,
      persons,
      now,
    });
    expect((await stores.idempotencyStore.get({ key: "other", now }))?.answer).toEqual(
      testAnswer("other"),
    );
    // A record filed elsewhere since it was read is no longer here to reseal.
    await stores.idempotencyStore.erase({ key: "other", filed: "moved", now });
    await stores.idempotencyStore.reseal({
      key: "other",
      from: testAnswer("other"),
      answer: resealed,
      persons,
      now,
    });
    expect(await stores.idempotencyStore.get({ key: "other", now })).toBeNull();
    await stores.idempotencyStore.reseal({
      key: "live",
      from: testAnswer("live"),
      answer: resealed,
      persons,
      now,
    });
    expect(await stores.idempotencyStore.get({ key: "held", now })).toMatchObject({
      answer: resealed,
      persons,
    });
    expect((await storage.idempotencyStore.get({ key: "live", now }))?.answer).toEqual(
      testAnswer("live"),
    );
    await flush(storage);
    expect((await storage.idempotencyStore.get({ key: "live", now }))?.answer).toEqual(resealed);
    expect((await storage.idempotencyStore.get({ key: "held", now }))?.answer).toEqual(resealed);
    expect(await storage.idempotencyStore.get({ key: "other", now })).toBeNull();
  });

  it("lists and erases only what has not expired, and keeps a live record where it files one", async () => {
    const storage = await memory().createStorage();
    await storage.idempotencyStore.put(record("live", []));
    const { stores } = deferWrites(storage);
    await stores.idempotencyStore.put({
      ...record("short", []),
      expiresAt: later(1).toISOString(),
    });
    await stores.idempotencyStore.put(record("plain", []));
    expect((await stores.idempotencyStore.list({ now: later(1) })).map(({ key }) => key)).toEqual([
      "live",
      "plain",
    ]);
    expect((await stores.idempotencyStore.list({ now, offset: 1 })).map(({ key }) => key)).toEqual([
      "plain",
      "short",
    ]);
    await stores.idempotencyStore.erase({ key: "short", now: later(1) });
    expect((await stores.idempotencyStore.get({ key: "short", now }))?.answer).toEqual(
      testAnswer("short"),
    );
    await stores.idempotencyStore.erase({ key: "plain", filed: "live", now });
    expect(await stores.idempotencyStore.get({ key: "plain", now })).toBeNull();
    expect((await stores.idempotencyStore.get({ key: "live", now }))?.answer).toEqual(
      testAnswer("live"),
    );
    await stores.idempotencyStore.erase({ key: "plain", filed: "elsewhere", now });
    expect(await stores.idempotencyStore.get({ key: "elsewhere", now })).toBeNull();
  });

  it("forgets and withdraws only what names a person under a key outside the ones kept", async () => {
    const storage = await memory().createStorage();
    await storage.personalKeys.add("c-1", "default", stored("1"));
    await storage.personalKeys.add("c-1", "profile", stored("2"));
    const { stores, flush, withdrawScheduled, withdrawLetters } = deferWrites(storage);
    for (const [key, fingerprint] of [
      ["kept", "1"],
      ["gone", "2"],
      ["clear", null],
    ] as const) {
      await stores.idempotencyStore.put(record(key, [held("c-1", fingerprint)]));
      await stores.scheduler.schedule({
        dedupeKey: key,
        command: testCommand("c-1"),
        executeAt: now,
        scheduledAt: now,
        context: testContext,
        persons: [held("c-1", fingerprint)],
      });
      await stores.deadLetterStore.add({
        ...testDeadLetter(key),
        kind: "scheduled",
        persons: [held("c-1", fingerprint)],
      });
    }
    await stores.idempotencyStore.forget("c-1", ["f-1"]);
    expect(withdrawScheduled("c-1", ["f-1"]).map(({ dedupeKey }) => dedupeKey)).toEqual([
      "gone",
      "clear",
    ]);
    expect(withdrawLetters("c-1", ["f-1"]).map(({ id }) => id)).toEqual(["gone", "clear"]);
    await flush(storage);
    const kept = async (key: string) =>
      [
        (await storage.idempotencyStore.get({ key, now }))?.answer !== null,
        (await storage.scheduler.list()).some(({ dedupeKey }) => dedupeKey === key),
        (await storage.deadLetterStore.list()).some(({ id }) => id === key),
      ] as const;
    expect(await kept("kept")).toEqual([true, true, true]);
    expect(await kept("gone")).toEqual([false, false, false]);
    expect(await kept("clear")).toEqual([false, false, false]);
  });

  it("clears the letters it holds back with the live ones, but those of the event kept", async () => {
    const storage = await memory().createStorage();
    await storage.deadLetterStore.add(testDeadLetter("live"));
    const { stores, flush } = deferWrites(storage);
    await stores.deadLetterStore.add(testDeadLetter("held"));
    await stores.deadLetterStore.add({ ...testDeadLetter("notice"), eventId: "kept" });
    await stores.deadLetterStore.clear("kept");
    expect(await storage.deadLetterStore.list()).toEqual([]);
    await flush(storage);
    expect((await storage.deadLetterStore.list()).map(({ id }) => id)).toEqual(["notice"]);
  });

  it("lists what names a person from the live stores, not from the writes held back", async () => {
    const storage = await memory().createStorage();
    const persons = [held("c-1", "1")];
    await storage.scheduler.schedule({
      dedupeKey: "live",
      command: testCommand("c-1"),
      executeAt: now,
      scheduledAt: now,
      context: testContext,
      persons,
    });
    await storage.deadLetterStore.add({ ...testDeadLetter("live"), kind: "scheduled", persons });
    const { stores } = deferWrites(storage);
    await stores.scheduler.schedule({
      dedupeKey: "held",
      command: testCommand("c-1"),
      executeAt: now,
      scheduledAt: now,
      context: testContext,
      persons,
    });
    await stores.deadLetterStore.add({ ...testDeadLetter("held"), kind: "scheduled", persons });
    expect(
      (await stores.scheduler.listByPerson({ person: "c-1" })).map((entry) => entry.dedupeKey),
    ).toEqual(["live"]);
    expect(
      (await stores.deadLetterStore.listByPerson({ person: "c-1" })).map((letter) => letter.id),
    ).toEqual(["live"]);
  });
});
