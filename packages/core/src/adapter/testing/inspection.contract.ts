import { describe, expect, it } from "vitest";
import { silentLogger } from "../../contracts/logger.ts";
import type { Adapter } from "../adapter.ts";
import type { InspectedTable } from "../storage/inspection.ts";
import { pendingEvent, testCommand, testContext, testDeadLetter, testOutcome } from "./fixtures.ts";
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

    it("reads the storage's tables whole, as stored, each row named by columns it holds", async () => {
      const adapter = await create();
      const storage = await adapter.createStorage();
      const now = new Date("2026-01-01T00:00:00.000Z");
      await storage.eventStore.append({
        aggregateType: "order",
        aggregateId: "o-1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "o-1", version: 1, payload: { note: "ring twice" } })],
      });
      await storage.personalKeys.add("c-2", { key: "a2V5Mg==", fingerprint: "ZnAy", kid: null });
      await storage.personalKeys.add("c-1", { key: "a2V5", fingerprint: "ZnA=", kid: null });
      await storage.checkpointStore.set("orders", 1);
      await storage.inboxLedger.tryClaim({ handler: "order.p", eventId: "e1", now, leaseMs: 1 });
      await storage.scheduler.schedule({
        dedupeKey: "command:c1",
        command: testCommand("1"),
        executeAt: now,
        context: testContext,
      });
      await storage.deadLetterStore.add(testDeadLetter("dl-1"));
      await storage.idempotencyStore.put({
        key: "idem-1",
        fingerprint: "fp",
        outcome: testOutcome("1"),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        persons: [],
        now,
      });
      await storage.persons.restrict("c-1", now);
      await storage.snapshotStore.put({
        aggregateType: "order",
        aggregateId: "o-1",
        version: 1,
        fingerprint: "abc",
        state: "{}",
        persons: [],
      });
      await storage.subscriberFailures.record({
        subscriber: "projection:orders",
        position: 1,
        eventId: "e-1",
        eventType: "OrderPlaced",
        person: null,
        errorName: "Error",
        errorMessage: "boom",
        failedAt: now.toISOString(),
      });
      const tables = await adapter.inspect();
      for (const { name } of tables) expect(name.startsWith("bounda_")).toBe(true);
      for (const [name, store] of [
        ["bounda_events", "events"],
        ["bounda_checkpoints", "checkpoints"],
        ["bounda_inbox", "inbox"],
        ["bounda_scheduled_commands", "scheduledCommands"],
        ["bounda_dead_letters", "deadLetters"],
        ["bounda_idempotency_keys", "idempotencyKeys"],
        ["bounda_personal_keys", "personalKeys"],
        ["bounda_persons", "persons"],
        ["bounda_snapshots", "snapshots"],
        ["bounda_subscriber_failures", "subscriberFailures"],
      ] as const) {
        const table = tableOf(tables, name);
        expect(table.store, name).toBe(store);
        expect(table.rows.length, name).toBeGreaterThan(0);
        expect(table.key.length, name).toBeGreaterThan(0);
        for (const row of table.rows) {
          for (const column of table.key) expect(row[column], `${name}.${column}`).toBeDefined();
        }
        if (name !== "bounda_personal_keys") expect(table.opaque, name).toEqual([]);
      }
      // A versioned database keeps its schema's versions too, and names them.
      const versions = tables.find(({ name }) => name === "bounda_migrations");
      if (versions !== undefined) expect(versions.store).toBe("migrations");
      expect(tables.filter(({ store }) => store === null)).toEqual([]);
      const events = tableOf(tables, "bounda_events");
      expect(events.key).toEqual(["position"]);
      expect(events.rows).toHaveLength(1);
      expect(JSON.stringify(events.rows)).toContain("ring twice");
      const keys = tableOf(tables, "bounda_personal_keys");
      expect([...keys.opaque].sort()).toEqual(["fingerprint", "key"]);
      expect(keys.rows.map((row) => [row.person, row.key])).toEqual([
        ["c-1", "a2V5"],
        ["c-2", "a2V5Mg=="],
      ]);
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
      expect(live.rows.map((row) => row[live.key[0] ?? ""])).toEqual(["o-1"]);
      expect(live.opaque).toEqual([]);
      expect(live.store).toBe("readModel");
      expect(tableOf(tables, "bounda_rm_order_summary__rebuild").store).toBe("readModel");
      expect(JSON.stringify(live.rows)).toContain("c-1");
      expect(JSON.stringify(tableOf(tables, "bounda_rm_order_summary__rebuild").rows)).toContain(
        "c-2",
      );
      await rebuild.abort();
      await model.close();
    });

    it("reads a forget ledger kept in its database", async () => {
      const adapter = await create();
      const opened = await adapter.createForgetLedger({ tenant: "t-1" });
      await opened.append([
        {
          personId: "c-1",
          eventId: "e-1",
          forgottenAt: "2026-11-07T12:00:00.000Z",
          reason: "requested",
          fingerprints: [],
        },
      ]);
      const ledger = tableOf(await adapter.inspect(), "bounda_forget_ledger");
      const { rows } = ledger;
      expect(rows).toEqual([expect.objectContaining({ tenant: "t-1" })]);
      expect(ledger.key).toHaveLength(2);
      expect(ledger.store).toBe("forgetLedger");
      for (const column of ledger.key) expect(rows[0]?.[column]).toBeDefined();
      expect(JSON.stringify(rows)).toContain("e-1");
      await opened.close?.();
    });
  });
};
