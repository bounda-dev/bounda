import { describe, expect, it } from "vitest";
import { silentLogger } from "../../contracts/logger.ts";
import type { Adapter } from "../adapter.ts";
import type { InspectedTable } from "../storage/inspection.ts";
import { pendingEvent } from "./fixtures.ts";
import { type ContractRow, contractFields } from "./table.contract.ts";

export interface InspectionContractArgs {
  /**
   * An adapter over an empty database, with the default table prefix.
   */
  readonly create: () => Promise<Adapter>;
}

export interface InspectionContractFunction {
  (args: InspectionContractArgs): void;
}

const tableOf = (tables: readonly InspectedTable[], name: string): InspectedTable => {
  const table = tables.find((candidate) => candidate.name === name);
  if (table === undefined) throw new Error(`no table ${name} in ${tables.map((t) => t.name)}`);
  return table;
};

/**
 * The behaviour every adapter's `inspect` must exhibit. Call it inside a `describe` of the
 * adapter's test file.
 */
export const inspectionContract: InspectionContractFunction = ({ create }) => {
  describe("inspection contract", () => {
    it("finds no row before anything is written", async () => {
      const adapter = await create();
      for (const table of await adapter.inspect()) expect(table.rows).toEqual([]);
    });

    it("reads the storage's tables whole, as stored, each with its key", async () => {
      const adapter = await create();
      const storage = await adapter.createStorage();
      await storage.eventStore.append({
        aggregateType: "order",
        aggregateId: "o-1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "o-1", version: 1, payload: { note: "ring twice" } })],
      });
      await storage.personalKeys.add("c-1", { key: "a2V5", fingerprint: "ZnA=", kid: null });
      const tables = await adapter.inspect();
      const events = tableOf(tables, "bounda_events");
      expect(events.key.length).toBeGreaterThan(0);
      expect(events.rows).toHaveLength(1);
      expect(JSON.stringify(events.rows)).toContain("ring twice");
      const keys = tableOf(tables, "bounda_personal_keys");
      expect(keys.opaque).toEqual(expect.arrayContaining(["key", "fingerprint"]));
      expect(keys.rows).toEqual([expect.objectContaining({ person: "c-1", key: "a2V5" })]);
      expect(tables.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "bounda_checkpoints",
          "bounda_dead_letters",
          "bounda_idempotency_keys",
          "bounda_inbox",
          "bounda_persons",
          "bounda_scheduled_commands",
          "bounda_snapshots",
        ]),
      );
      for (const { name } of tables) expect(name.startsWith("bounda_")).toBe(true);
      await storage.close();
    });

    it("reads a read model's rows, and those of its rebuild", async () => {
      const adapter = await create();
      const model = await adapter.createReadModel<ContractRow>({
        name: "orderSummary",
        fields: contractFields,
        logger: silentLogger,
      });
      await model.table.upsert({ orderId: "o-1", customerId: "c-1", status: "paid", total: 7 });
      const rebuild = await adapter.rebuildReadModel<ContractRow>({
        name: "orderSummary",
        fields: contractFields,
        logger: silentLogger,
        progress: "rebuild:orderSummary",
      });
      await rebuild.transact(async ({ table }) => {
        await table.upsert({ orderId: "o-2", customerId: "c-2", status: "new", total: 1 });
      });
      const tables = await adapter.inspect();
      const live = tableOf(tables, "bounda_rm_order_summary");
      expect(live.key).toHaveLength(1);
      expect(JSON.stringify(live.rows)).toContain("c-1");
      expect(JSON.stringify(tableOf(tables, "bounda_rm_order_summary__rebuild").rows)).toContain(
        "c-2",
      );
      await rebuild.abort();
      await model.close();
    });

    it("reads a forget ledger kept in its database", async () => {
      const adapter = await create();
      const ledger = await adapter.createForgetLedger({ tenant: "t-1" });
      await ledger.append([
        { personId: "c-1", eventId: "e-1", forgottenAt: "2026-11-07T12:00:00.000Z" },
      ]);
      const rows = tableOf(await adapter.inspect(), "bounda_forget_ledger").rows;
      expect(rows).toEqual([expect.objectContaining({ tenant: "t-1" })]);
      expect(JSON.stringify(rows)).toContain("e-1");
      await ledger.close?.();
    });
  });
};
