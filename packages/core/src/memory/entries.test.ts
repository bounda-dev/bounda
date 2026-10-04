import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../contracts/errors.ts";
import { entriesOf, keepEntries } from "./entries.ts";

const kept = () => {
  const map = new Map([
    ["changed", "a"],
    ["removed", "b"],
  ]);
  const store = keepEntries({}, map, (key: string) => key);
  return { map, entries: entriesOf<string>(store) };
};

describe("keepEntries", () => {
  it("reads an entry and puts back what a write replaced, removed or added", () => {
    const { map, entries } = kept();
    const before = ["changed", "removed", "added"].map((key) => entries.read(key));
    map.set("changed", "a2");
    map.delete("removed");
    map.set("added", "c");
    entries.putBack("changed", before[0], "a2");
    entries.putBack("removed", before[1], undefined);
    entries.putBack("added", before[2], "c");
    expect([...map].sort()).toEqual([
      ["changed", "a"],
      ["removed", "b"],
    ]);
  });

  it("leaves an entry alone that changed since the write", () => {
    const { map, entries } = kept();
    map.set("changed", "a3");
    map.set("removed", "b2");
    entries.putBack("changed", "a", "a2");
    entries.putBack("removed", "b", undefined);
    entries.putBack("added", undefined, "c");
    expect([...map].sort()).toEqual([
      ["changed", "a3"],
      ["removed", "b2"],
    ]);
  });

  it("maps a key to the entry it names", () => {
    const map = new Map([["s\u0000e", "claim"]]);
    const store = keepEntries(
      {},
      map,
      ({ subscriber, eventId }: { subscriber: string; eventId: string }) =>
        `${subscriber}\u0000${eventId}`,
    );
    const entries = entriesOf<{ subscriber: string; eventId: string }>(store);
    expect(entries.read({ subscriber: "s", eventId: "e" })).toBe("claim");
    entries.putBack({ subscriber: "s", eventId: "e" }, undefined, "claim");
    expect(map.size).toBe(0);
  });
});

describe("entriesOf", () => {
  it("refuses a store the memory adapter did not make", () => {
    expect(() => entriesOf({})).toThrow(ConfigurationError);
    expect(() => entriesOf({})).toThrow("needs the stores the memory adapter made");
  });
});
