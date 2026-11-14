import { describe, expect, it } from "vitest";
import { leavesIn, MIN_SUBSTRING_LENGTH, matches, needlesOf } from "./value-search.ts";

const found = (value: unknown, haystack: unknown, opaque = false): boolean => {
  const [needle] = needlesOf({ values: [value], personId: "c-1" });
  if (needle === undefined) throw new Error("no needle");
  return leavesIn(haystack, opaque).some((leaf) => matches(needle, leaf));
};

describe("needlesOf", () => {
  it("takes every string and number however deep, once whatever its case, and never a key", () => {
    const needles = needlesOf({
      values: [
        { email: "Ana@example.com", address: { street: "Main St 1", floor: 3 } },
        ["ana@EXAMPLE.com", 42n, new Date("2026-01-01T00:00:00Z")],
        true,
        null,
        undefined,
        "  ",
      ],
      personId: "c-1",
    });
    expect(needles.map(({ value }) => value)).toEqual([
      "Ana@example.com",
      "Main St 1",
      "3",
      "42",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("never looks for the person's id, which stays by design", () => {
    expect(needlesOf({ values: ["C-1", "c-1"], personId: "c-1" })).toEqual([]);
  });
});

describe("matching", () => {
  it(`finds a value of ${MIN_SUBSTRING_LENGTH} characters or more inside any text, case aside`, () => {
    expect(found("ana@example.com", "no mailbox for ANA@EXAMPLE.COM.")).toBe(true);
    expect(found("Garcia", "AnaGarciaLopez")).toBe(true);
    expect(found("Garcia", "Garci")).toBe(false);
  });

  it("finds a shorter value only as a whole word", () => {
    expect(found("Ana", "Hello, ana!")).toBe(true);
    expect(found("Ana", "Ana")).toBe(true);
    expect(found("Ana", "Banana")).toBe(false);
    expect(found("ada", "metadata")).toBe(false);
    expect(found("Zoë", "für Zoë.")).toBe(true);
    expect(found("Zoë", "Zoëy")).toBe(false);
    expect(found("a.b", "axb")).toBe(false);
    expect(found("a+b", "x a+b y")).toBe(true);
  });

  it("compares key material and ciphertext whole, never inside", () => {
    expect(found("Ana", "xAna/+", true)).toBe(false);
    expect(found("ana", "ANA", true)).toBe(true);
    expect(
      found("Ana", { $personal: { person: "c-1", key: "k", iv: "+Ana+", data: "Ana+" } }),
    ).toBe(false);
    expect(found("Ana", { persons: [{ person: "c-2", fingerprint: "+Ana+" }] })).toBe(false);
    expect(found("Ana", { $personal: { person: "Ana Smith", key: "k", iv: "i", data: "d" } })).toBe(
      true,
    );
    expect(leavesIn({ $personal: { person: "c-1", key: "k", iv: "i", data: "d" } })).toEqual([
      { path: ["$personal", "person"], text: "c-1", lower: "c-1", opaque: false },
      { path: ["$personal", "key"], text: "k", lower: "k", opaque: true },
      { path: ["$personal", "iv"], text: "i", lower: "i", opaque: true },
      { path: ["$personal", "data"], text: "d", lower: "d", opaque: true },
    ]);
    expect(leavesIn({ $personal: null })).toEqual([
      { path: ["$personal"], text: "$personal", lower: "$personal", opaque: false },
    ]);
  });

  it("reads a JSON document held as text, its keys included, and bytes as UTF-8", () => {
    expect(found("ana@example.com", '{"to":["ana@example.com"]}')).toBe(true);
    expect(found("ana@example.com", '{"ana@example.com":3}')).toBe(true);
    expect(found("ana@example.com", "{not json ana@example.com")).toBe(true);
    expect(found("ana@example.com", new TextEncoder().encode("to ana@example.com"))).toBe(true);
    expect(found("ana@example.com", new TextEncoder().encode("to ana@example.com").buffer)).toBe(
      true,
    );
    expect(found("2026-01-01T00:00:00.000Z", new Date("2026-01-01T00:00:00Z"))).toBe(true);
    expect(found("42", 42)).toBe(true);
    expect(leavesIn(42n)).toEqual([{ path: [], text: "42", lower: "42", opaque: false }]);
    expect(leavesIn(new Date("not a date"))).toEqual([
      { path: [], text: "", lower: "", opaque: false },
    ]);
    expect(leavesIn("true")).toEqual([{ path: [], text: "true", lower: "true", opaque: false }]);
    expect(leavesIn('  ["ana@example.com"]').map(({ path }) => path)).toEqual([["[0]"]]);
    expect(leavesIn('{"a":1} trailing').map(({ text }) => text)).toEqual(['{"a":1} trailing']);
    expect(leavesIn("plain [text").map(({ text }) => text)).toEqual(["plain [text"]);
    expect(found("42", [true, null, undefined, () => 42])).toBe(false);
  });

  it("names the path to what it found", () => {
    const self: Record<string, unknown> = { to: "ana@example.com" };
    self.self = self;
    expect(leavesIn({ payload: '{"lines":[{"note":"x"}]}' }).map(({ path }) => path)).toEqual([
      ["payload"],
      ["payload", "lines"],
      ["payload", "lines", "[0]", "note"],
      ["payload", "lines", "[0]", "note"],
    ]);
    expect(leavesIn(self).filter(({ text }) => text === "ana@example.com")).toHaveLength(1);
  });
});
