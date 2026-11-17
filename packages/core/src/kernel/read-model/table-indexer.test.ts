import { describe, expect, it, vi } from "vitest";
import type { BlindIndexer, IndexedTable, PinnedIndexer } from "../personal-data/blind-index.ts";
import { lazyTableIndexer, tableIndexer } from "./table-indexer.ts";

const args = { readModel: "customers", field: "email", type: "string" as const, value: "a@x" };

// An indexer whose table indexer names the key the table is under: `old` while it holds rows.
const indexerOf = (): BlindIndexer & { readonly tables: IndexedTable[] } => {
  const tables: IndexedTable[] = [];
  const under = (epoch: string): PinnedIndexer => ({
    epoch,
    number: 1,
    index: async ({ value }) => `${epoch}:${String(value)}`,
    forTable: async () => under(epoch),
    pinned: async () => under(epoch),
    indexAll: async ({ value }) => [`${epoch}:${String(value)}`],
  });
  return {
    tables,
    epoch: "new",
    index: async ({ value }) => `new:${String(value)}`,
    forTable: async (table) => {
      tables.push(table);
      return under((await table.isEmpty()) ? "new" : "old");
    },
    pinned: async () => under("new"),
    indexAll: async ({ value }) => [`new:${String(value)}`, `old:${String(value)}`],
  };
};

const checkpoints = { get: async () => 0, set: async () => undefined };

describe("tableIndexer", () => {
  it("is none without an indexer, and the table's own otherwise, told whether it is empty and written", async () => {
    const table = { findMany: vi.fn(async () => [{ id: 1 }]) };
    expect(
      await tableIndexer({
        indexer: null,
        readModel: "customers",
        checkpoints,
        table,
        writes: true,
      }),
    ).toBeNull();
    const indexer = indexerOf();
    const found = await tableIndexer({
      indexer,
      readModel: "customers",
      checkpoints,
      table,
      writes: true,
    });
    expect(found?.epoch).toBe("old");
    expect(table.findMany).toHaveBeenCalledWith({ limit: 1 });
    expect(indexer.tables[0]).toMatchObject({ readModel: "customers", checkpoints, writes: true });
    table.findMany.mockResolvedValueOnce([]);
    expect(
      (await tableIndexer({ indexer, readModel: "c", checkpoints, table, writes: false }))?.epoch,
    ).toBe("new");
  });
});

describe("lazyTableIndexer", () => {
  it("reads the table's key at its first index alone, once, and matches under every key without it", async () => {
    expect(
      lazyTableIndexer({
        indexer: null,
        readModel: "c",
        checkpoints,
        table: { findMany: async () => [] },
      }),
    ).toBeNull();
    const indexer = indexerOf();
    const table = { findMany: vi.fn(async () => [{ id: 1 }]) };
    const lazy = lazyTableIndexer({ indexer, readModel: "customers", checkpoints, table });
    if (lazy === null) throw new Error("no indexer");
    expect(lazy.epoch).toBe("new");
    expect(await lazy.indexAll(args)).toEqual(["new:a@x", "old:a@x"]);
    expect(table.findMany).not.toHaveBeenCalled();
    expect(await lazy.index(args)).toBe("old:a@x");
    expect(await lazy.index(args)).toBe("old:a@x");
    expect(table.findMany).toHaveBeenCalledTimes(1);
    expect(indexer.tables).toHaveLength(1);
    expect(indexer.tables[0]?.writes).toBe(false);
    expect((await lazy.pinned()).epoch).toBe("new");
    expect(
      (await lazy.forTable({ ...indexer.tables[0], isEmpty: async () => true } as IndexedTable))
        .epoch,
    ).toBe("new");
  });
});
