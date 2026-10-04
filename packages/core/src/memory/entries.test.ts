import { describe, expect, it } from "vitest";
import { createStoreEntries } from "./entries.ts";

const kept = () => {
  const map = new Map([
    ["changed", "a"],
    ["removed", "b"],
  ]);
  return { map, entries: createStoreEntries(map, (key: string) => key) };
};

describe("createStoreEntries", () => {
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
    const entries = createStoreEntries(
      map,
      ({ subscriber, eventId }: { subscriber: string; eventId: string }) =>
        `${subscriber}\u0000${eventId}`,
    );
    expect(entries.read({ subscriber: "s", eventId: "e" })).toBe("claim");
    entries.putBack({ subscriber: "s", eventId: "e" }, undefined, "claim");
    expect(map.size).toBe(0);
  });
});
