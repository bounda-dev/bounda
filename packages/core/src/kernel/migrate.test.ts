import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "../adapter/sqlite/node-sqlite.ts";
import { memory } from "../memory/index.ts";
import { migrateTables } from "./migrate.ts";

const tablesIn = (db: ReturnType<typeof createNodeSqliteAdapter>["db"]): string[] =>
  (
    db.prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table' ORDER BY "name"`).all() as {
      name: string;
    }[]
  ).map(({ name }) => name);

describe("migrateTables", () => {
  it("migrates every database the configuration names to this release, each with its own scopes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-migrate-"));
    const storage = createNodeSqliteAdapter(join(directory, "storage.db"));
    const readModels = createNodeSqliteAdapter(join(directory, "read-models.db"));
    const ledger = createNodeSqliteAdapter(join(directory, "ledger.db"));
    const config = {
      storage: storage.adapter,
      readModels: { customers: readModels.adapter, orders: storage.adapter },
      runtime: { personalData: { forgetLedger: { store: ledger.adapter } } },
    };
    expect(await migrateTables({ config })).toEqual([
      { database: "storage", scope: "storage", version: 5, latest: 5 },
      { database: "storage", scope: "checkpoints", version: 3, latest: 3 },
      { database: "readModels.customers", scope: "checkpoints", version: 3, latest: 3 },
      { database: "forgetLedger", scope: "forget-ledger", version: 6, latest: 6 },
    ]);
    expect(tablesIn(readModels.db)).toEqual([
      "bounda_checkpoints",
      "bounda_migrations",
      "bounda_restricted_persons",
      "bounda_restricted_positions",
    ]);
    expect(tablesIn(ledger.db)).toEqual([
      "bounda_forget_ledger",
      "bounda_forget_ledger_marks",
      "bounda_migrations",
    ]);
    expect(tablesIn(storage.db)).toContain("bounda_subscriber_failures");
    expect(tablesIn(storage.db)).not.toContain("bounda_forget_ledger");
    expect(await migrateTables({ config })).toHaveLength(4);
  });

  it("has nothing to migrate in a store without tables", async () => {
    expect(await migrateTables({ config: { storage: memory() } })).toEqual([]);
  });

  it("refuses a configuration it cannot read before migrating anything", async () => {
    await expect(
      migrateTables({ config: { storage: memory(), runtime: { role: "nobody" } } as never }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
});
