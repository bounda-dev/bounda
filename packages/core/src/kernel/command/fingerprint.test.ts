import { describe, expect, it } from "vitest";
import { fingerprintOf } from "./fingerprint.ts";

describe("fingerprintOf", () => {
  it("is a SHA-256 in hex of the type and the payload", async () => {
    const fingerprint = await fingerprintOf({ type: "PlaceOrder", payload: { total: 1 } });
    expect(fingerprint).toBe("6d14c4deeefd3d85dac3648381f574fd5e93da3ec6bba0967f6b5857ca5b4187");
    expect(await fingerprintOf({ type: "PlaceOrder", payload: { total: 1 } })).toBe(fingerprint);
    // A digest with a byte below 16, whose hex keeps its leading zero.
    expect(await fingerprintOf({ type: "T", payload: {} })).toBe(
      "780ee647afcb9daf8dcdb984331fadbe36e98c600af7973d9d2fff89f976f0e7",
    );
  });

  it("tells an array from an object with its indexes as keys", async () => {
    expect(await fingerprintOf({ type: "T", payload: ["a"] })).not.toBe(
      await fingerprintOf({ type: "T", payload: { 0: "a" } }),
    );
  });

  it("changes with the type and with the payload", async () => {
    const base = await fingerprintOf({ type: "PlaceOrder", payload: { total: 1 } });
    expect(await fingerprintOf({ type: "PayOrder", payload: { total: 1 } })).not.toBe(base);
    expect(await fingerprintOf({ type: "PlaceOrder", payload: { total: 2 } })).not.toBe(base);
    expect(await fingerprintOf({ type: "PlaceOrder", payload: [{ total: 1 }] })).not.toBe(base);
  });

  it("ignores the order of keys, at every depth", async () => {
    const one = await fingerprintOf({
      type: "T",
      payload: { a: 1, b: { c: [{ d: 1, e: 2 }], f: 3 } },
    });
    const other = await fingerprintOf({
      type: "T",
      payload: { b: { f: 3, c: [{ e: 2, d: 1 }] }, a: 1 },
    });
    expect(other).toBe(one);
    expect(
      await fingerprintOf({ type: "T", payload: { a: 1, b: { c: [{ e: 2, d: 1 }] } } }),
    ).not.toBe(one);
  });

  it("takes dates as their JSON, and no payload as none", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(await fingerprintOf({ type: "T", payload: { at } })).toBe(
      await fingerprintOf({ type: "T", payload: { at: at.toISOString() } }),
    );
    expect(await fingerprintOf({ type: "T", payload: undefined })).toBe(
      await fingerprintOf({ type: "T", payload: null }),
    );
    expect(await fingerprintOf({ type: "T", payload: undefined })).not.toBe(
      await fingerprintOf({ type: "T", payload: {} }),
    );
  });

  it("tells payloads apart by what their maps, sets and bigints hold, in any order", async () => {
    const of = (payload: unknown) => fingerprintOf({ type: "T", payload });
    expect(await of({ items: new Map([[1, "a"]]) })).not.toBe(
      await of({ items: new Map([[2, "b"]]) }),
    );
    expect(
      await of({
        items: new Map<number, unknown>([
          [1, "a"],
          [2, { y: 1, x: 2 }],
        ]),
      }),
    ).toBe(
      await of({
        items: new Map<number, unknown>([
          [2, { x: 2, y: 1 }],
          [1, "a"],
        ]),
      }),
    );
    expect(await of({ tags: new Set(["a"]) })).not.toBe(await of({ tags: new Set(["b"]) }));
    expect(await of({ tags: new Set(["a", "b"]) })).toBe(await of({ tags: new Set(["b", "a"]) }));
    expect(await of({ items: new Map() })).not.toBe(await of({ items: {} }));
    expect(await of({ items: new Set() })).not.toBe(await of({ items: new Map() }));
    expect(await of({ amount: 10n })).not.toBe(await of({ amount: 11n }));
    expect(await of({ amount: 10n })).not.toBe(await of({ amount: "10" }));
  });

  it("tells a scheduled command from an immediate one, and delays apart", async () => {
    const now = await fingerprintOf({ type: "T", payload: { a: 1 } });
    const later = await fingerprintOf({ type: "T", payload: { a: 1 }, delayMs: 60_000 });
    expect(later).not.toBe(now);
    expect(await fingerprintOf({ type: "T", payload: { a: 1 }, delayMs: 60_000 })).toBe(later);
    expect(await fingerprintOf({ type: "T", payload: { a: 1 }, delayMs: 0 })).not.toBe(now);
    expect(await fingerprintOf({ type: "T", payload: { a: 1 }, delayMs: 1 })).not.toBe(later);
  });
});
