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

  it("reseals an answer it holds back or the live store holds, on flush", async () => {
    const storage = await memory().createStorage();
    await storage.personalKeys.add("c-1", "default", stored("1"));
    await storage.idempotencyStore.put(record("live", [held("c-1", "1")]));
    const { stores, flush } = deferWrites(storage);
    await stores.idempotencyStore.put(record("held", [held("c-1", "1")]));
    const resealed = { answer: testAnswer("again"), persons: [held("c-1", "1")], now };
    for (const key of ["live", "held"]) {
      expect(await stores.idempotencyStore.reseal({ ...resealed, key })).toBe(true);
      expect((await stores.idempotencyStore.get({ key, now }))?.answer).toEqual(
        testAnswer("again"),
      );
    }
    expect(await stores.idempotencyStore.reseal({ ...resealed, key: "none" })).toBe(false);
    expect((await storage.idempotencyStore.get({ key: "live", now }))?.answer).toEqual(
      testAnswer("live"),
    );
    await flush(storage);
    for (const key of ["live", "held"]) {
      expect((await storage.idempotencyStore.get({ key, now }))?.answer).toEqual(
        testAnswer("again"),
      );
    }
    await stores.idempotencyStore.forget("c-1");
    expect(await stores.idempotencyStore.reseal({ ...resealed, key: "held" })).toBe(false);
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

  it("lists what names a person from the live stores, not from the writes held back", async () => {
    const storage = await memory().createStorage();
    const persons = [held("c-1", "1")];
    await storage.scheduler.schedule({
      dedupeKey: "live",
      command: testCommand("c-1"),
      executeAt: now,
      context: testContext,
      persons,
    });
    await storage.deadLetterStore.add({ ...testDeadLetter("live"), kind: "scheduled", persons });
    const { stores } = deferWrites(storage);
    await stores.scheduler.schedule({
      dedupeKey: "held",
      command: testCommand("c-1"),
      executeAt: now,
      context: testContext,
      persons,
    });
    await stores.deadLetterStore.add({ ...testDeadLetter("held"), kind: "scheduled", persons });
    expect((await stores.scheduler.listByPerson("c-1")).map((entry) => entry.dedupeKey)).toEqual([
      "live",
    ]);
    expect((await stores.deadLetterStore.listByPerson("c-1")).map((letter) => letter.id)).toEqual([
      "live",
    ]);
  });
});
