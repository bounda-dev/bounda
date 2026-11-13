import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { createMemoryIndexKeyStore } from "../../memory/index-key-store.ts";
import { indexedText, openBlindIndexer } from "./blind-index.ts";
import { buildKeyWrapper } from "./key-wrapper.ts";
import { masterKey } from "./master-key.ts";
import { createPersonalKeyWrapping } from "./wrapped-keys.ts";

const bytes = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const env = { KEY_1: bytes(1), KEY_2: bytes(2) };

const wrappingUnder = async (from: string, previous: readonly string[] = []) =>
  createPersonalKeyWrapping({
    wrapper: await buildKeyWrapper({ definition: masterKey({ from, previous }), env }),
    clock: createFixedClock(),
  });

describe("indexedText", () => {
  it("indexes a value by its JSON, a date by its ISO string, and a JSON field whatever the order of its keys", () => {
    expect(indexedText("string", "a@x")).toBe('"a@x"');
    expect(indexedText("number", 4)).toBe("4");
    expect(indexedText("boolean", true)).toBe("true");
    expect(indexedText("date", new Date("2026-01-01T00:00:00.000Z"))).toBe(
      '"2026-01-01T00:00:00.000Z"',
    );
    expect(indexedText("date", "2026-01-01T00:00:00Z")).toBe('"2026-01-01T00:00:00.000Z"');
    expect(indexedText("json", { b: [{ d: 1, c: 2 }], a: null })).toBe(
      indexedText("json", { a: null, b: [{ c: 2, d: 1 }] }),
    );
    expect(indexedText("json", { b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("openBlindIndexer", () => {
  it("creates the database's key once, wrapped, and indexes alike across instances, apart for each read model and field", async () => {
    const store = createMemoryIndexKeyStore();
    const clock = createFixedClock();
    const wrapping = await wrappingUnder("KEY_1");
    const one = await openBlindIndexer({ store, wrapping, clock });
    const [stored] = store.rows();
    expect(stored).toMatchObject({ scope: "app", kid: wrapping.wrapper?.kid });
    const other = await openBlindIndexer({ store, wrapping: await wrappingUnder("KEY_1"), clock });
    const args = { readModel: "customers", field: "email", type: "string" as const, value: "a@x" };
    const index = await one.index(args);
    expect(index).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(await other.index(args)).toBe(index);
    expect(store.rows()).toHaveLength(1);
    expect(await one.index({ ...args, value: "b@x" })).not.toBe(index);
    expect(await one.index({ ...args, field: "backup" })).not.toBe(index);
    expect(await one.index({ ...args, readModel: "accounts" })).not.toBe(index);
    const elsewhere = await openBlindIndexer({
      store: createMemoryIndexKeyStore(),
      wrapping,
      clock,
    });
    expect(await elsewhere.index(args)).not.toBe(index);
  });

  it("rewraps a key wrapped under a previous key of the wrapper, and keeps one kept unwrapped as it is without one", async () => {
    const store = createMemoryIndexKeyStore();
    const clock = createFixedClock();
    const before = await openBlindIndexer({ store, wrapping: await wrappingUnder("KEY_1"), clock });
    const args = { readModel: "customers", field: "email", type: "string" as const, value: "a@x" };
    const index = await before.index(args);
    const rotated = await wrappingUnder("KEY_2", ["KEY_1"]);
    const after = await openBlindIndexer({ store, wrapping: rotated, clock });
    expect(store.rows()[0]?.kid).toBe(rotated.wrapper?.kid);
    expect(await after.index(args)).toBe(index);
    const plain = createMemoryIndexKeyStore();
    const unwrapped = createPersonalKeyWrapping({ wrapper: null, clock });
    await openBlindIndexer({ store: plain, wrapping: unwrapped, clock });
    expect(plain.rows()[0]?.kid).toBeNull();
  });
});
