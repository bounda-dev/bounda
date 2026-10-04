import { describe, expect, it } from "vitest";
import { createEntryJournal, type EntryWrite } from "./entry-journal.ts";

const seeded = (entries: [string, string][]) => {
  const journal = createEntryJournal<string, string>();
  for (const [key, value] of entries) journal.map.set(key, value);
  const { map } = journal;
  const write = (key: string, value: string | undefined): EntryWrite => {
    const written = journal.track(key);
    if (value === undefined) map.delete(key);
    else map.set(key, value);
    return written();
  };
  return { journal, map, write };
};

describe("createEntryJournal", () => {
  it("puts back the entry a write replaced, removed or added", () => {
    const { map, write } = seeded([
      ["changed", "a"],
      ["removed", "b"],
    ]);
    const writes = [write("changed", "a2"), write("removed", undefined), write("added", "c")];
    for (const written of writes) written.undo();
    expect([...map].sort()).toEqual([
      ["changed", "a"],
      ["removed", "b"],
    ]);
  });

  it("leaves an entry alone when someone changed it after the write", () => {
    const { map, write } = seeded([
      ["changed", "a"],
      ["removed", "b"],
    ]);
    const writes = [write("changed", "a2"), write("removed", undefined), write("added", "c")];
    map.set("changed", "a3");
    map.set("removed", "b2");
    map.delete("added");
    for (const written of writes) written.undo();
    expect([...map].sort()).toEqual([
      ["changed", "a3"],
      ["removed", "b2"],
    ]);
  });

  it("puts back what was there before two pending writes once both are undone, in either order", () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const { map, write } = seeded([["k", "a"]]);
      const writes = [write("k", "b"), write("k", "c")];
      for (const index of order) writes[index]?.undo();
      expect([...map]).toEqual([["k", "a"]]);
    }
  });

  it("keeps a write that built on an undone one when it is kept", () => {
    const { map, write } = seeded([["k", "a"]]);
    const first = write("k", "b");
    const second = write("k", "c");
    first.undo();
    second.keep();
    expect([...map]).toEqual([["k", "c"]]);
  });

  it("forgets a kept write, so undoing an older one leaves the entry alone", () => {
    const { map, write } = seeded([["k", "a"]]);
    const first = write("k", "b");
    write("k", "c").keep();
    first.undo();
    expect([...map]).toEqual([["k", "c"]]);
  });

  it("hands nothing to a later write when someone changed the entry between them", () => {
    const { map, write } = seeded([["k", "a"]]);
    const first = write("k", "b");
    map.set("k", "x");
    const second = write("k", "c");
    first.undo();
    second.undo();
    expect([...map]).toEqual([["k", "x"]]);
  });

  it("puts back what was there before a write that changed the entry twice", () => {
    const { journal, map } = seeded([["k", "a"]]);
    const written = journal.track("k");
    map.set("k", "b");
    map.set("k", "c");
    written().undo();
    expect([...map]).toEqual([["k", "a"]]);
  });

  it("records a change only against a write open on that entry", () => {
    const { journal, map } = seeded([["k", "a"]]);
    const onK = journal.track("k");
    const onOther = journal.track("other");
    map.set("k", "b");
    onOther().undo();
    onK().undo();
    expect([...map]).toEqual([["k", "a"]]);
  });

  it("undoes nothing for a write that changed nothing", () => {
    const { journal, map } = seeded([["k", "a"]]);
    const nothing = journal.track("k")();
    map.set("k", "x");
    nothing.undo();
    expect([...map]).toEqual([["k", "x"]]);
  });

  it("records a change against the newest write open on the entry, however long it stays open", () => {
    const { journal, map } = seeded([["k", "a"]]);
    const slow = journal.track("k");
    const fast = journal.track("k");
    map.set("k", "fast");
    const fastWrite = fast();
    const slowWrite = (() => {
      map.set("k", "slow");
      return slow();
    })();
    fastWrite.keep();
    slowWrite.undo();
    expect([...map]).toEqual([["k", "fast"]]);
  });
});
