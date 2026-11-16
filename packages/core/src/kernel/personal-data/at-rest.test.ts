import { describe, expect, it, vi } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import { memory } from "../../memory/index.ts";
import {
  createAtRestSealer,
  isSealedAtRest,
  type SealedAtRest,
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

  it("files a key under its HMAC, the same for one base and another under another, its key derived once", async () => {
    const base = await baseKey();
    const sealer = createAtRestSealer(base);
    const derived = vi.spyOn(crypto.subtle, "deriveKey");
    const filed = await sealer.lookup("register-ana@example.com");
    expect(await sealer.lookup("register-ana@example.com")).toBe(filed);
    expect(derived.mock.calls.map((call) => [call[3], call[4]])).toEqual([[false, ["sign"]]]);
    derived.mockRestore();
    expect(filed).not.toContain("ana");
    expect(filed).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(await sealer.lookup("register-bo@example.com")).not.toBe(filed);
    expect(await createAtRestSealer(base).lookup("register-ana@example.com")).toBe(filed);
    expect(await createAtRestSealer(await baseKey()).lookup("register-ana@example.com")).not.toBe(
      filed,
    );
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
