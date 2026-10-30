import { describe, expect, it } from "vitest";
import type { FoldedState } from "./fold-state.ts";
import { deserializeFold, foldsEqual, serializeFold } from "./snapshot-codec.ts";

const fold = (state: object, rest: Partial<FoldedState> = {}): FoldedState => ({
  state,
  created: true,
  openedWithout: null,
  ...rest,
});

describe("serializeFold and deserializeFold", () => {
  it("keeps what JSON loses, and the fold's flags", () => {
    const folded = fold(
      {
        placedAt: new Date("2026-03-01T10:00:00.000Z"),
        lines: new Map([["sku-1", { quantity: 2 }]]),
        tags: new Set(["gift", "fragile"]),
        total: 12n,
        note: undefined,
        gaps: [1, undefined, Number.NaN, Number.POSITIVE_INFINITY],
        pattern: /^ord-/u,
      },
      { created: false, openedWithout: "OrderPlaced" },
    );
    const restored = deserializeFold(serializeFold(folded));
    expect(restored).toEqual(folded);
    expect(restored.state).not.toBe(folded.state);
    expect(Reflect.get(restored.state, "placedAt")).toBeInstanceOf(Date);
    expect(Reflect.get(restored.state, "lines")).toBeInstanceOf(Map);
    expect(Reflect.get(restored.state, "tags")).toBeInstanceOf(Set);
    expect(Object.hasOwn(restored.state, "note")).toBe(true);
  });

  it("refuses a state that cannot be kept", () => {
    class Clock {}
    expect(() => serializeFold(fold({ clock: new Clock() }))).toThrow(
      "Cannot stringify arbitrary non-POJOs",
    );
    expect(() => serializeFold(fold({ tick: () => 1 }))).toThrow(/function/);
  });

  it("refuses text that is not a serialized fold", () => {
    expect(() => deserializeFold("not json")).toThrow();
    expect(() => deserializeFold("[1]")).toThrow("not a serialized fold");
    expect(() => deserializeFold(serializeFold(fold({})).replace("true", "1"))).toThrow(
      "not a serialized fold",
    );
    expect(() =>
      deserializeFold(JSON.stringify([{ state: 1, created: 2, openedWithout: 3 }, [], true, null])),
    ).toThrow("not a serialized fold");
    expect(() =>
      deserializeFold(JSON.stringify([{ state: 1, created: 2, openedWithout: 3 }, {}, true, 4])),
    ).toThrow("not a serialized fold");
  });
});

describe("foldsEqual", () => {
  it("compares states by structure, whatever the order of their fields", () => {
    expect(foldsEqual(fold({ a: 1, b: [1, { c: 2 }] }), fold({ b: [1, { c: 2 }], a: 1 }))).toBe(
      true,
    );
    expect(foldsEqual(fold({ a: 1 }), fold({ a: 2 }))).toBe(false);
    expect(foldsEqual(fold({ a: 1 }), fold({ a: 1, b: undefined }))).toBe(false);
    expect(foldsEqual(fold({ a: 1, b: 2 }), fold({ a: 1, c: 2 }))).toBe(false);
    expect(foldsEqual(fold({ a: [1, 2] }), fold({ a: { 0: 1, 1: 2 } }))).toBe(false);
    expect(foldsEqual(fold({ a: null }), fold({ a: {} }))).toBe(false);
    expect(foldsEqual(fold({ a: {} }), fold({ a: null }))).toBe(false);
    expect(foldsEqual(fold({ a: 1 }), fold({ a: {} }))).toBe(false);
    expect(foldsEqual(fold({ a: {} }), fold({ a: 1 }))).toBe(false);
    expect(foldsEqual(fold({ a: Number.NaN }), fold({ a: Number.NaN }))).toBe(true);
  });

  it("tells a date, a map and a set from an object that looks like one", () => {
    expect(foldsEqual(fold({ at: new Date(0) }), fold({ at: {} }))).toBe(false);
    expect(foldsEqual(fold({ at: {} }), fold({ at: new Date(0) }))).toBe(false);
    expect(foldsEqual(fold({ lines: { size: 0 } }), fold({ lines: new Map() }))).toBe(false);
    expect(foldsEqual(fold({ lines: new Map() }), fold({ lines: { size: 0 } }))).toBe(false);
    expect(foldsEqual(fold({ tags: { size: 0 } }), fold({ tags: new Set() }))).toBe(false);
    expect(foldsEqual(fold({ tags: new Set() }), fold({ tags: { size: 0 } }))).toBe(false);
    expect(foldsEqual(fold({ tags: new Set() }), fold({ tags: {} }))).toBe(false);
    expect(foldsEqual(fold({ lines: new Map() }), fold({ lines: {} }))).toBe(false);
    expect(foldsEqual(fold({ at: new Date(0) }), fold({ at: {} }))).toBe(false);
  });

  it("compares dates, maps and sets by value", () => {
    const at = "2026-03-01T10:00:00.000Z";
    expect(foldsEqual(fold({ at: new Date(at) }), fold({ at: new Date(at) }))).toBe(true);
    expect(foldsEqual(fold({ at: new Date(at) }), fold({ at: new Date(0) }))).toBe(false);
    expect(foldsEqual(fold({ at: new Date(at) }), fold({ at }))).toBe(false);
    expect(
      foldsEqual(
        fold({ lines: new Map([["a", { quantity: 1 }]]) }),
        fold({ lines: new Map([["a", { quantity: 1 }]]) }),
      ),
    ).toBe(true);
    expect(
      foldsEqual(
        fold({ lines: new Map([["a", { quantity: 1 }]]) }),
        fold({ lines: new Map([["a", { quantity: 2 }]]) }),
      ),
    ).toBe(false);
    expect(
      foldsEqual(fold({ lines: new Map([["a", 1]]) }), fold({ lines: new Map([["b", 1]]) })),
    ).toBe(false);
    expect(
      foldsEqual(
        fold({
          lines: new Map([
            ["a", 1],
            ["b", 2],
          ]),
        }),
        fold({
          lines: new Map([
            ["a", 1],
            ["b", 3],
          ]),
        }),
      ),
    ).toBe(false);
    expect(foldsEqual(fold({ tags: new Set([1, 2]) }), fold({ tags: new Set([1, 3]) }))).toBe(
      false,
    );
    expect(
      foldsEqual(
        fold({ tags: new Set([{ id: 1 }, { id: 2 }]) }),
        fold({ tags: new Set([{ id: 1 }, { id: 3 }]) }),
      ),
    ).toBe(false);
    expect(
      foldsEqual(
        fold({ lines: new Map([["a", 1]]) }),
        fold({
          lines: new Map([
            ["a", 1],
            ["b", 2],
          ]),
        }),
      ),
    ).toBe(false);
    expect(foldsEqual(fold({ lines: new Map() }), fold({ lines: {} }))).toBe(false);
    expect(
      foldsEqual(
        fold({ tags: new Set([{ id: 1 }, "x"]) }),
        fold({ tags: new Set(["x", { id: 1 }]) }),
      ),
    ).toBe(true);
    expect(
      foldsEqual(fold({ tags: new Set([{ id: 1 }]) }), fold({ tags: new Set([{ id: 2 }]) })),
    ).toBe(false);
    expect(foldsEqual(fold({ tags: new Set([1]) }), fold({ tags: new Set([1, 2]) }))).toBe(false);
    expect(foldsEqual(fold({ tags: new Set() }), fold({ tags: [] }))).toBe(false);
  });

  it("tells folds apart by whether and how the aggregate opened", () => {
    expect(foldsEqual(fold({}), fold({}, { created: false }))).toBe(false);
    expect(foldsEqual(fold({}), fold({}, { openedWithout: "OrderPlaced" }))).toBe(false);
  });
});
