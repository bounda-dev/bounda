import { describe, expect, it } from "vitest";
import { silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import { deferWrites } from "./deferred-writes.ts";
import type { KeyedPerson } from "./storage/personal-key-store.ts";
import {
  testKeyedPerson as held,
  testPersonalKey as stored,
  testOutcome,
} from "./testing/fixtures.ts";

const now = new Date("2026-01-01T00:00:00.000Z");
const record = (key: string, persons: readonly KeyedPerson[]) => ({
  key,
  fingerprint: "fp",
  outcome: testOutcome(key),
  expiresAt: "2026-01-02T00:00:00.000Z",
  persons,
  now,
});

describe("deferWrites", () => {
  it("forgets the idempotency records it holds back for a person, and forgets them on flush", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    await storage.personalKeys.add("c-1", stored("1"));
    await storage.idempotencyStore.put(record("live", [held("c-1", "1")]));
    const { stores, flush } = deferWrites(storage);
    await stores.idempotencyStore.put(record("held", [held("c-1", "1")]));
    await stores.idempotencyStore.put(record("other", []));
    await stores.idempotencyStore.put(record("bo", [held("c-2", "2")]));
    await stores.idempotencyStore.forget("c-1");
    expect(await stores.idempotencyStore.get({ key: "held", now })).toBeNull();
    expect(await stores.idempotencyStore.get({ key: "other", now })).not.toBeNull();
    expect(await stores.idempotencyStore.get({ key: "bo", now })).not.toBeNull();
    expect(await storage.idempotencyStore.get({ key: "live", now })).not.toBeNull();
    await flush(storage);
    expect(await storage.idempotencyStore.get({ key: "live", now })).toBeNull();
    expect(await storage.idempotencyStore.get({ key: "held", now })).toBeNull();
    expect(await storage.idempotencyStore.get({ key: "other", now })).not.toBeNull();
  });
});
