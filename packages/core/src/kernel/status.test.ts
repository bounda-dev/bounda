import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "../adapter/sqlite/node-sqlite.ts";
import { resolveConfig } from "../config/schema.ts";
import { memory } from "../memory/index.ts";
import { databasesOf } from "./status.ts";

describe("databasesOf", () => {
  it("names each database once, an adapter over the storage's own database included", () => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-databases-"));
    const storage = createNodeSqliteAdapter(join(directory, "storage.db")).adapter;
    const alsoStorage = createNodeSqliteAdapter(join(directory, "storage.db")).adapter;
    const reports = createNodeSqliteAdapter(join(directory, "reports.db")).adapter;
    const names = databasesOf(
      resolveConfig({
        storage,
        readModels: { orders: alsoStorage, reports, totals: reports, notes: memory() },
      }),
    ).map(({ database, scopes }) => [database, scopes]);
    expect(names).toEqual([
      ["storage", ["storage", "checkpoints"]],
      ["readModels.reports", ["checkpoints"]],
      ["readModels.notes", ["checkpoints"]],
    ]);
  });
});
