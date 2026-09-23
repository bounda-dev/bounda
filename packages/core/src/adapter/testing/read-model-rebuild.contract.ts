import { beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../contracts/logger.ts";
import type { FieldsRecord } from "../../modules/view.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import type { Adapter } from "../adapter.ts";
import { type ContractRow, contractFields } from "./table.contract.ts";

/**
 * The shape the contract rebuilds `ContractRow` into: one field gone, one changed type, one new.
 */
export interface RebuiltRow {
  readonly orderId: string;
  readonly customerId: string;
  readonly total: string;
  readonly lines: number;
}

/**
 * Field definitions matching `RebuiltRow`.
 */
export const rebuiltFields: FieldsRecord = {
  orderId: f.string().primaryKey(),
  customerId: f.string().index(),
  total: f.string(),
  lines: f.number(),
};

export interface ReadModelRebuildContractArgs {
  /**
   * A fresh adapter per test, with nothing in it.
   */
  readonly create: () => Promise<Adapter>;
}

export interface ReadModelRebuildContractFunction {
  (args: ReadModelRebuildContractArgs): void;
}

const NAME = "orderSummary";

const live = (orderId: string, total = 10): ContractRow => ({
  orderId,
  customerId: "c-1",
  status: "placed",
  total,
});

const rebuilt = (orderId: string, lines = 1): RebuiltRow => ({
  orderId,
  customerId: "c-1",
  total: "ten",
  lines,
});

/**
 * The behaviour every adapter's `rebuildReadModel` must exhibit.
 */
export const readModelRebuildContract: ReadModelRebuildContractFunction = ({ create }) => {
  describe("read model rebuild contract", () => {
    let adapter: Adapter;

    beforeEach(async () => {
      adapter = await create();
    });

    it("fills a shadow table the live one does not see until commit, then swaps them", async () => {
      const before = await adapter.createReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
      });
      await before.table.insert(live("1"));
      await before.table.insert(live("2"));

      const rebuild = await adapter.rebuildReadModel<RebuiltRow>({
        name: NAME,
        fields: rebuiltFields,
        logger: silentLogger,
      });
      await rebuild.table.insert(rebuilt("1"));
      await rebuild.table.insert(rebuilt("3"));
      expect(await rebuild.table.count()).toBe(2);
      expect(
        await before.table.findMany({ orderBy: { field: "orderId", direction: "asc" } }),
      ).toEqual([live("1"), live("2")]);

      await rebuild.commit();
      await before.close();
      const after = await adapter.createReadModel<RebuiltRow>({
        name: NAME,
        fields: rebuiltFields,
        logger: silentLogger,
      });
      expect(
        await after.table.findMany({ orderBy: { field: "orderId", direction: "asc" } }),
      ).toEqual([rebuilt("1"), rebuilt("3")]);
      expect(await after.table.findMany({ where: { customerId: "c-1" } })).toHaveLength(2);
      await after.close();
    });

    it("shows the rebuilt rows through the live table when the fields did not change", async () => {
      const ports = await adapter.createReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
      });
      await ports.table.insert(live("1", 10));
      const rebuild = await adapter.rebuildReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
      });
      await rebuild.table.insert(live("1", 99));
      await rebuild.commit();
      expect(await ports.table.findOne({ orderId: "1" })).toEqual(live("1", 99));
      await ports.table.upsert(live("4"));
      expect(await ports.table.count()).toBe(2);
      await ports.close();
    });

    it("leaves the live table alone on abort and discards what an interrupted rebuild left", async () => {
      const ports = await adapter.createReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
      });
      await ports.table.insert(live("1"));
      const aborted = await adapter.rebuildReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
      });
      await aborted.table.insert(live("2"));
      await aborted.abort();
      expect(await ports.table.findMany()).toEqual([live("1")]);

      const interrupted = await adapter.rebuildReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
      });
      await interrupted.table.insert(live("3"));
      const next = await adapter.rebuildReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
      });
      expect(await next.table.count()).toBe(0);
      await next.table.insert(live("4"));
      await next.commit();
      expect(await ports.table.findMany()).toEqual([live("4")]);
      await ports.close();
    });

    it("keeps a paused shadow, rows included, for a rebuild that asks to resume it", async () => {
      const ports = await adapter.createReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
      });
      await ports.table.insert(live("1"));
      const first = await adapter.rebuildReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
        resume: true,
      });
      expect(first.resumed).toBe(false);
      await first.table.insert(live("2", 20));
      await first.pause();
      expect(await ports.table.findMany()).toEqual([live("1")]);

      const second = await adapter.rebuildReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
        resume: true,
      });
      expect(second.resumed).toBe(true);
      expect(await second.table.findMany()).toEqual([live("2", 20)]);
      await second.table.insert(live("3", 30));
      await second.commit();
      expect(
        await ports.table.findMany({ orderBy: { field: "orderId", direction: "asc" } }),
      ).toEqual([live("2", 20), live("3", 30)]);

      const afterCommit = await adapter.rebuildReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
        resume: true,
      });
      expect(afterCommit.resumed).toBe(false);
      expect(await afterCommit.table.count()).toBe(0);
      await afterCommit.abort();
      await ports.close();
    });

    it("discards a paused shadow when the next rebuild does not ask to resume, or after abort", async () => {
      const paused = await adapter.rebuildReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
      });
      expect(paused.resumed).toBe(false);
      await paused.table.insert(live("1"));
      await paused.pause();
      const fresh = await adapter.rebuildReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
      });
      expect(fresh.resumed).toBe(false);
      expect(await fresh.table.count()).toBe(0);
      await fresh.table.insert(live("2"));
      await fresh.abort();
      const afterAbort = await adapter.rebuildReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
        resume: true,
      });
      expect(afterAbort.resumed).toBe(false);
      expect(await afterAbort.table.count()).toBe(0);
      await afterAbort.abort();
    });

    it("creates the live table when the read model never had one, and can rebuild again", async () => {
      const first = await adapter.rebuildReadModel<RebuiltRow>({
        name: NAME,
        fields: rebuiltFields,
        logger: silentLogger,
      });
      await first.table.insert(rebuilt("1"));
      await first.commit();
      const second = await adapter.rebuildReadModel<RebuiltRow>({
        name: NAME,
        fields: rebuiltFields,
        logger: silentLogger,
      });
      await second.table.insert(rebuilt("2"));
      await second.commit();
      const ports = await adapter.createReadModel<RebuiltRow>({
        name: NAME,
        fields: rebuiltFields,
        logger: silentLogger,
      });
      expect(await ports.table.findMany({ where: { customerId: "c-1" } })).toEqual([rebuilt("2")]);
      await ports.close();
    });
  });
};
