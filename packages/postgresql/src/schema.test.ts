import { describe, expect, it } from "vitest";
import { fenceLockOf, storageTablesFor } from "./schema.ts";

describe("storageTablesFor", () => {
  it("qualifies every advisory lock by the schema and the table, so stores apart never wait on each other", () => {
    expect(storageTablesFor({ prefix: "app_", schema: "tenant_a" })).toMatchObject({
      appendLockKey: "bounda:tenant_a.app_events",
      checkpointsLockKey: "bounda:tenant_a.app_checkpoints",
      forgetLedgerLockKey: "bounda:tenant_a.app_forget_ledger",
    });
    expect(fenceLockOf("bounda:tenant_a.app_checkpoints")).toEqual([
      "bounda:tenant_a.app_checkpoints",
      "bounda:tenant-fence",
    ]);
  });
});
