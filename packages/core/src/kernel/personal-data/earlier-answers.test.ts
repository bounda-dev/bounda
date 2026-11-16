import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { memory } from "../../memory/index.ts";
import { createAtRestSealer } from "./at-rest.ts";
import { createEarlierAnswers, EARLIER_ANSWERS_FILED, isEarlierAnswer } from "./earlier-answers.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const EXPIRES = "2026-01-02T00:00:00.000Z";

const sealer = async () =>
  createAtRestSealer(
    await crypto.subtle.importKey(
      "raw",
      crypto.getRandomValues(new Uint8Array(32)),
      "HKDF",
      false,
      ["deriveKey"],
    ),
  );

const clear = { fingerprint: "fp", outcome: { aggregateType: "a", aggregateId: "1", version: 1 } };

const put = (storage: Storage, key: string, answer: object | null) =>
  storage.idempotencyStore.put({ key, answer, expiresAt: EXPIRES, persons: [], now: NOW });

describe("isEarlierAnswer", () => {
  it("is an answer kept in the clear, never one sealed or erased", () => {
    expect(isEarlierAnswer(clear)).toBe(true);
    expect(isEarlierAnswer(null)).toBe(false);
    expect(isEarlierAnswer({ $sealed: { salt: "s", data: "d" } })).toBe(false);
    expect(
      isEarlierAnswer({ $personal: { person: "c", key: "k", iv: "i", data: "d", category: "x" } }),
    ).toBe(false);
  });
});

describe("createEarlierAnswers", () => {
  it("files every answer kept in the clear under its key's HMAC, erased, across pages, once", async () => {
    const storage = await memory().createStorage();
    const atRest = await sealer();
    const keys = Array.from({ length: 130 }, (_, index) => `k-${String(index).padStart(3, "0")}`);
    for (const key of keys) await put(storage, key, clear);
    await put(storage, "sealed", { $sealed: { salt: "s", data: "d" } });
    const earlier = createEarlierAnswers({ storage, atRest, clock: createFixedClock(NOW) });
    expect(earlier.settled()).toBe(false);
    await earlier.file();
    expect(earlier.settled()).toBe(true);
    expect(await storage.checkpointStore.get(EARLIER_ANSWERS_FILED)).toBe(1);
    const listed = await storage.idempotencyStore.list({ now: NOW });
    expect(listed).toHaveLength(131);
    expect(listed.filter(({ answer }) => answer !== null).map(({ key }) => key)).toEqual([
      "sealed",
    ]);
    for (const key of keys) {
      expect(await storage.idempotencyStore.get({ key, now: NOW })).toBeNull();
      expect(
        await storage.idempotencyStore.get({ key: await atRest.lookup(key), now: NOW }),
      ).toEqual({ key: await atRest.lookup(key), answer: null, expiresAt: EXPIRES, persons: [] });
    }
  });

  it("reads nothing once the database says it was done, until a restore resets it", async () => {
    const storage = await memory().createStorage();
    const atRest = await sealer();
    await storage.checkpointStore.set(EARLIER_ANSWERS_FILED, 1);
    await put(storage, "plain", clear);
    const earlier = createEarlierAnswers({ storage, atRest, clock: createFixedClock(NOW) });
    await earlier.file();
    expect(earlier.settled()).toBe(true);
    expect((await storage.idempotencyStore.get({ key: "plain", now: NOW }))?.answer).toEqual(clear);
    await storage.checkpointStore.remove(EARLIER_ANSWERS_FILED);
    earlier.reset();
    expect(earlier.settled()).toBe(false);
    await earlier.file();
    expect(await storage.idempotencyStore.get({ key: "plain", now: NOW })).toBeNull();
  });

  it("is settled from the start in an app without keys, which files every key as it is", async () => {
    const storage = await memory().createStorage();
    await put(storage, "plain", clear);
    const earlier = createEarlierAnswers({ storage, atRest: null, clock: createFixedClock(NOW) });
    expect(earlier.settled()).toBe(true);
    await earlier.file();
    earlier.reset();
    expect(earlier.settled()).toBe(true);
    expect((await storage.idempotencyStore.get({ key: "plain", now: NOW }))?.answer).toEqual(clear);
  });

  it("files once for calls that overlap, tries again after a failure, and settles nothing a reset overtook", async () => {
    const storage = await memory().createStorage();
    const atRest = await sealer();
    await put(storage, "plain", clear);
    let lists = 0;
    let failing = true;
    const counted: Storage = {
      ...storage,
      idempotencyStore: {
        ...storage.idempotencyStore,
        list: async (args) => {
          lists += 1;
          if (failing) throw new Error("store down");
          return storage.idempotencyStore.list(args);
        },
      },
    };
    const earlier = createEarlierAnswers({
      storage: counted,
      atRest,
      clock: createFixedClock(NOW),
    });
    await expect(earlier.file()).rejects.toThrow("store down");
    expect(earlier.settled()).toBe(false);
    failing = false;
    lists = 0;
    await Promise.all([earlier.file(), earlier.file()]);
    expect(lists).toBe(2);
    expect(earlier.settled()).toBe(true);

    await storage.checkpointStore.remove(EARLIER_ANSWERS_FILED);
    earlier.reset();
    const overtaken = earlier.file();
    earlier.reset();
    await overtaken;
    expect(earlier.settled()).toBe(false);
  });
});
