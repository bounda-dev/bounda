import { describe, expect, it } from "vitest";
import { createStoreEntries } from "./entries.ts";
import { byKey, entriesRows, storageTable } from "./inspection.ts";

describe("memory inspection", () => {
  it("orders rows by their key, numbers as numbers, each column breaking the tie of the one before", () => {
    expect(byKey([{ p: 10 }, { p: 2 }, { p: 1 }], ["p"])).toEqual([{ p: 1 }, { p: 2 }, { p: 10 }]);
    expect(
      byKey(
        [
          { a: "b", b: "1" },
          { a: "a", b: "2" },
          { a: "a", b: "1" },
        ],
        ["a", "b"],
      ),
    ).toEqual([
      { a: "a", b: "1" },
      { a: "a", b: "2" },
      { a: "b", b: "1" },
    ]);
    expect(byKey([{ a: 2 }, { a: 1 }], [])).toEqual([{ a: 2 }, { a: 1 }]);
  });

  it("names a store's table as the SQL adapters do, and reads its entries with the key they are filed by", () => {
    const map = new Map<string, { readonly key: string }>([
      ["c-2", { key: "k2" }],
      ["c-1", { key: "k1" }],
    ]);
    const entries = createStoreEntries(map, (person: string) => person);
    expect(entriesRows(entries)).toEqual([{ key: "k2" }, { key: "k1" }]);
    expect(
      storageTable({
        table: "personalKeys",
        key: ["person"],
        rows: entriesRows(entries, "person"),
      }),
    ).toEqual({
      name: "bounda_personal_keys",
      key: ["person"],
      opaque: [],
      rows: [
        { person: "c-1", key: "k1" },
        { person: "c-2", key: "k2" },
      ],
    });
  });
});
