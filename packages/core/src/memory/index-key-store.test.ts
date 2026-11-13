import { describe, expect, it } from "vitest";
import { createMemoryIndexKeyStore } from "./index-key-store.ts";

describe("createMemoryIndexKeyStore", () => {
  it("keeps the first key added, and rewraps it only while it is still the one read", async () => {
    const store = createMemoryIndexKeyStore();
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(await store.get()).toBeNull();
    expect(
      await store.rewrap({ key: "k", fingerprint: "f", kid: null }, { key: "x", kid: "n" }),
    ).toBe(false);
    const first = { key: "k", fingerprint: "f", kid: null };
    expect(await store.add(first, at)).toEqual(first);
    expect(await store.add({ key: "k2", fingerprint: "f2", kid: null }, at)).toEqual(first);
    expect(await store.rewrap({ ...first, fingerprint: "other" }, { key: "x", kid: "n" })).toBe(
      false,
    );
    expect(await store.rewrap({ ...first, key: "other" }, { key: "x", kid: "n" })).toBe(false);
    expect(await store.rewrap(first, { key: "x", kid: "n" })).toBe(true);
    expect(await store.get()).toEqual({ key: "x", fingerprint: "f", kid: "n" });
    expect(store.rows()).toEqual([
      {
        scope: "app",
        fingerprint: "f",
        key: "x",
        kid: "n",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });
});
