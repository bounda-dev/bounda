import { describe, expect, it } from "vitest";
import { codePointOrder } from "./order.ts";

describe("codePointOrder", () => {
  it("orders text by code point, a character above U+FFFF after U+E000–U+FFFF", () => {
    expect(["b", "\u{1F600}", "a-2", "！", "B", "a", "", "퟿"].sort(codePointOrder)).toEqual([
      "B",
      "a",
      "a-2",
      "b",
      "퟿",
      "",
      "！",
      "\u{1F600}",
    ]);
  });

  it("puts a prefix first and equal text level", () => {
    expect(codePointOrder("ab", "abc")).toBeLessThan(0);
    expect(codePointOrder("abc", "ab")).toBeGreaterThan(0);
    expect(codePointOrder("ab", "ab")).toBe(0);
  });
});
