import { describe, expect, it, vi } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import { testOutcome } from "../../adapter/testing/fixtures.ts";
import { memory } from "../../memory/index.ts";
import {
  createAtRestSealer,
  isSealedAtRest,
  type SealedAtRest,
  sealedAnswers,
  sealedSnapshots,
} from "./at-rest.ts";

const baseKey = (): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "HKDF", false, [
    "deriveKey",
  ]);

const storage = (): Promise<Storage> => memory().createStorage();

const stream = { aggregateType: "order", aggregateId: "o-1" };

describe("createAtRestSealer", () => {
  it("seals each record under a salt of its own, and opens it under the same base alone", async () => {
    const sealer = createAtRestSealer(await baseKey());
    const derived = vi.spyOn(crypto.subtle, "deriveKey");
    const first = await sealer.seal('{"email":"ada@example.com"}');
    // Each record's key is derived where no byte of it can be read.
    expect(derived.mock.calls.map((call) => call[3])).toEqual([false]);
    derived.mockRestore();
    const second = await sealer.seal('{"email":"ada@example.com"}');
    expect(isSealedAtRest(first)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("ada@example.com");
    expect(first.$sealed.salt).not.toBe(second.$sealed.salt);
    expect(first.$sealed.data).not.toBe(second.$sealed.data);
    expect(await sealer.open(first)).toBe('{"email":"ada@example.com"}');
    expect(await sealer.open(second)).toBe('{"email":"ada@example.com"}');
    await expect(createAtRestSealer(await baseKey()).open(first)).rejects.toThrow();
    const swapped: SealedAtRest = { $sealed: { ...first.$sealed, salt: second.$sealed.salt } };
    await expect(sealer.open(swapped)).rejects.toThrow();
  });

  it.each([
    [null],
    ["text"],
    [[{ $sealed: { salt: "s", data: "d" } }]],
    [{ $sealed: null }],
    [{ $sealed: { salt: "s" } }],
    [{ $sealed: { salt: 1, data: "d" } }],
    [{ $sealed: { salt: "s", data: 1 } }],
    [{ $sealed: { salt: "s", data: "d" }, other: true }],
  ])("tells %j from a sealed record", (value) => {
    expect(isSealedAtRest(value)).toBe(false);
  });
});

describe("sealedSnapshots", () => {
  it("keeps every state sealed, and takes one kept in the clear for no snapshot", async () => {
    const opened = await storage();
    const sealer = createAtRestSealer(await baseKey());
    const snapshots = sealedSnapshots(opened.snapshotStore, sealer);
    const snapshot = {
      ...stream,
      version: 3,
      fingerprint: "fp",
      state: '{"customer":"ada@example.com"}',
      persons: [],
    };
    await snapshots.put(snapshot);
    const stored = await opened.snapshotStore.get(stream);
    expect(stored?.state).not.toContain("ada@example.com");
    expect(isSealedAtRest(JSON.parse(stored?.state ?? "null"))).toBe(true);
    expect(await snapshots.get(stream)).toEqual(snapshot);

    await opened.snapshotStore.put(snapshot);
    expect(await snapshots.get(stream)).toBeNull();
    await opened.snapshotStore.put({ ...snapshot, state: "not json" });
    expect(await snapshots.get(stream)).toBeNull();
    expect(await snapshots.get({ ...stream, aggregateId: "o-2" })).toBeNull();
    await opened.close();
  });
});

describe("sealedAnswers", () => {
  it("keeps every answer sealed, and reads one kept in the clear as it is", async () => {
    const opened = await storage();
    const sealer = createAtRestSealer(await baseKey());
    const answers = sealedAnswers(opened.idempotencyStore, sealer);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const record = {
      fingerprint: "fp",
      outcome: testOutcome("ada@example.com"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      persons: [],
      now,
    };
    await answers.put({ ...record, key: "k-1" });
    const stored = await opened.idempotencyStore.get({ key: "k-1", now });
    expect(JSON.stringify(stored)).not.toContain("ada@example.com");
    expect(isSealedAtRest(stored?.outcome)).toBe(true);
    expect((await answers.get({ key: "k-1", now }))?.outcome).toEqual(record.outcome);

    await opened.idempotencyStore.put({ ...record, key: "k-2" });
    expect((await answers.get({ key: "k-2", now }))?.outcome).toEqual(record.outcome);
    expect(await answers.get({ key: "k-3", now })).toBeNull();
    await opened.close();
  });
});
