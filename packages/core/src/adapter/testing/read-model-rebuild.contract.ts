import { beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../contracts/logger.ts";
import type { FieldsRecord } from "../../modules/view.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import type { Adapter, ReadModelRebuild } from "../adapter.ts";
import type { Checkpoint } from "../ports/checkpoint-store.ts";
import { rebuildFencing } from "../rebuild-fencing.ts";
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
  /**
   * Whether the contract may run two calls at once and have one wait for the other. Defaults to
   * `true`. A harness that reaches the adapter through a host that cannot interleave calls from
   * the test, such as a Durable Object through `runInDurableObject`, passes `false` and covers
   * that behaviour inside the host instead.
   */
  readonly concurrent?: boolean;
}

export interface ReadModelRebuildContractFunction {
  (args: ReadModelRebuildContractArgs): void;
}

const NAME = "orderSummary";
const SUBSCRIBER = "projection:orderSummary";
const PROGRESS = "rebuild:orderSummary:0000000000000001";

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

const byId = { orderBy: { field: "orderId", direction: "asc" } } as const;

const withoutGenerations = (checkpoints: readonly Checkpoint[]): readonly Checkpoint[] =>
  checkpoints.filter(({ subscriber }) => subscriber !== rebuildFencing(NAME).generation);

/**
 * The behaviour every adapter's `rebuildReadModel` must exhibit.
 */
export const readModelRebuildContract: ReadModelRebuildContractFunction = ({
  create,
  concurrent = true,
}) => {
  describe("read model rebuild contract", () => {
    let adapter: Adapter;

    beforeEach(async () => {
      adapter = await create();
    });

    const open = <Row extends object>(
      fields: FieldsRecord = contractFields,
      progress = PROGRESS,
    ): Promise<ReadModelRebuild<Row>> =>
      adapter.rebuildReadModel<Row>({ name: NAME, fields, logger: silentLogger, progress });

    const openLive = <Row extends object>(fields: FieldsRecord = contractFields) =>
      adapter.createReadModel<Row>({ name: NAME, fields, logger: silentLogger });

    const project = <Row extends object>(
      rebuild: ReadModelRebuild<Row>,
      rows: readonly Row[],
      position: number,
      progress = PROGRESS,
    ) =>
      rebuild.transact(async ({ table, checkpointStore }) => {
        for (const row of rows) await table.upsert(row);
        await checkpointStore.set(progress, position);
      });

    it("fills a shadow the live table does not see until commit, then swaps them", async () => {
      const before = await openLive<ContractRow>();
      await before.table.insert(live("1"));
      await before.table.insert(live("2"));

      const rebuild = await open<RebuiltRow>(rebuiltFields);
      expect({ resumed: rebuild.resumed, position: rebuild.position }).toEqual({
        resumed: false,
        position: 0,
      });
      await project(rebuild, [rebuilt("1"), rebuilt("3")], 2);
      expect(await rebuild.table.count()).toBe(2);
      expect(await before.table.findMany(byId)).toEqual([live("1"), live("2")]);

      await rebuild.commit({ subscriber: SUBSCRIBER, position: 2 });
      await before.close();
      const after = await openLive<RebuiltRow>(rebuiltFields);
      expect(await after.table.findMany(byId)).toEqual([rebuilt("1"), rebuilt("3")]);
      expect(await after.table.findMany({ where: { customerId: "c-1" } })).toHaveLength(2);
      expect(await after.checkpointStore.get(SUBSCRIBER)).toBe(2);
      expect(withoutGenerations(await after.checkpointStore.list())).toEqual([
        { subscriber: SUBSCRIBER, position: 2 },
      ]);
      await after.close();
    });

    it("shows the rebuilt rows through the live table when the fields did not change", async () => {
      const ports = await openLive<ContractRow>();
      await ports.table.insert(live("1", 10));
      const rebuild = await open<ContractRow>();
      await project(rebuild, [live("1", 99)], 1);
      await rebuild.commit({ subscriber: SUBSCRIBER, position: 1 });
      expect(await ports.table.findOne({ orderId: "1" })).toEqual(live("1", 99));
      await ports.table.upsert(live("4"));
      expect(await ports.table.count()).toBe(2);
      await ports.close();
    });

    it("sets the checkpoint to the rebuilt position whether the projections were ahead or behind", async () => {
      const ports = await openLive<ContractRow>();
      for (const current of [40, 1]) {
        await ports.checkpointStore.set(SUBSCRIBER, current);
        const rebuild = await open<ContractRow>();
        await project(rebuild, [live("1")], 3);
        await rebuild.commit({ subscriber: SUBSCRIBER, position: 3 });
        expect(await ports.checkpointStore.get(SUBSCRIBER)).toBe(3);
      }
      await ports.close();
    });

    it.skipIf(!concurrent)("waits for a projection batch in flight before it swaps", async () => {
      const ports = await openLive<ContractRow>();
      const rebuild = await open<ContractRow>();
      await project(rebuild, [live("1", 99)], 5);
      const steps: string[] = [];
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = (): void => {};
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const batch = ports.transact({
        subscriber: SUBSCRIBER,
        wait: true,
        work: async ({ table }) => {
          await table.upsert(live("1", 7));
          entered();
          await held;
          steps.push("batch done");
        },
      });
      await inside;
      const committing = rebuild
        .commit({ subscriber: SUBSCRIBER, position: 5 })
        .then(() => steps.push("committed"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      await Promise.all([batch, committing]);
      expect(steps).toEqual(["batch done", "committed"]);
      expect(await ports.table.findMany()).toEqual([live("1", 99)]);
      expect(await ports.checkpointStore.get(SUBSCRIBER)).toBe(5);
      await ports.close();
    });

    it("lets a newer rebuild take over and stops the older one from writing anything", async () => {
      const ports = await openLive<ContractRow>();
      const older = await open<ContractRow>();
      await project(older, [live("1")], 1);
      const newer = await open<ContractRow>();
      expect({ resumed: newer.resumed, position: newer.position }).toEqual({
        resumed: true,
        position: 1,
      });
      const superseded = { code: "REBUILD_SUPERSEDED", readModel: NAME };
      await expect(project(older, [live("2")], 2)).rejects.toMatchObject(superseded);
      await expect(older.commit({ subscriber: SUBSCRIBER, position: 2 })).rejects.toMatchObject(
        superseded,
      );
      await older.abort();
      expect(await newer.table.findMany()).toEqual([live("1")]);
      await project(newer, [live("3")], 3);
      await newer.commit({ subscriber: SUBSCRIBER, position: 3 });
      expect(await ports.table.findMany(byId)).toEqual([live("1"), live("3")]);
      expect(withoutGenerations(await ports.checkpointStore.list())).toEqual([
        { subscriber: SUBSCRIBER, position: 3 },
      ]);
      await ports.close();
    });

    it("never lets a rebuild it took over from write again, however many come after", async () => {
      const first = await open<ContractRow>();
      const second = await open<ContractRow>();
      await second.abort();
      const third = await open<ContractRow>();
      const superseded = { code: "REBUILD_SUPERSEDED" };
      await expect(project(first, [live("1")], 1)).rejects.toMatchObject(superseded);
      await expect(project(second, [live("2")], 2)).rejects.toMatchObject(superseded);
      await project(third, [live("3")], 3);
      await first.abort();
      expect(await third.table.findMany()).toEqual([live("3")]);
      await third.abort();
    });

    it("leaves a rebuild of another read model alone", async () => {
      const orders = await open<ContractRow>();
      const other = await adapter.rebuildReadModel<ContractRow>({
        name: "customerSummary",
        fields: contractFields,
        logger: silentLogger,
        progress: "rebuild:customerSummary:0000000000000001",
      });
      await project(orders, [live("1")], 1);
      await other.abort();
      await orders.abort();
    });

    it.skipIf(!concurrent)(
      "takes over only once the older rebuild's batch in flight has committed",
      async () => {
        const older = await open<ContractRow>();
        let release = (): void => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered = (): void => {};
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const batch = older.transact(async ({ table, checkpointStore }) => {
          await table.upsert(live("1"));
          await checkpointStore.set(PROGRESS, 1);
          entered();
          await held;
        });
        await inside;
        const opening = open<ContractRow>();
        await new Promise<void>((resolve) => setImmediate(resolve));
        release();
        await batch;
        const newer = await opening;
        expect({ resumed: newer.resumed, position: newer.position }).toEqual({
          resumed: true,
          position: 1,
        });
        expect(await newer.table.findMany()).toEqual([live("1")]);
        await older.abort();
        await newer.abort();
      },
    );

    it("rolls a shadow batch and its progress back together when the work throws", async () => {
      const rebuild = await open<ContractRow>();
      await project(rebuild, [live("1")], 1);
      await expect(
        rebuild.transact(async ({ table, checkpointStore }) => {
          await table.upsert(live("2"));
          await checkpointStore.set(PROGRESS, 2);
          throw new Error("projection failed");
        }),
      ).rejects.toThrow("projection failed");
      expect(await rebuild.table.findMany()).toEqual([live("1")]);
      expect(await rebuild.checkpointStore.get(PROGRESS)).toBe(1);
      await rebuild.abort();
    });

    it("keeps a paused shadow and its progress, and resumes it under the same progress", async () => {
      const ports = await openLive<ContractRow>();
      await ports.table.insert(live("1"));
      const first = await open<ContractRow>();
      await project(first, [live("2", 20)], 2);
      await first.pause();
      expect(await ports.table.findMany()).toEqual([live("1")]);

      const second = await open<ContractRow>();
      expect({ resumed: second.resumed, position: second.position }).toEqual({
        resumed: true,
        position: 2,
      });
      expect(await second.table.findMany()).toEqual([live("2", 20)]);
      expect(await second.checkpointStore.get(PROGRESS)).toBe(2);
      await project(second, [live("3", 30)], 3);
      await second.commit({ subscriber: SUBSCRIBER, position: 3 });
      expect(await ports.table.findMany(byId)).toEqual([live("2", 20), live("3", 30)]);

      const afterCommit = await open<ContractRow>();
      expect({ resumed: afterCommit.resumed, position: afterCommit.position }).toEqual({
        resumed: false,
        position: 0,
      });
      expect(await afterCommit.table.count()).toBe(0);
      await afterCommit.abort();
      await ports.close();
    });

    it("starts from a fresh shadow when the progress is another's, its shadow is gone, or it was aborted", async () => {
      const paused = await open<ContractRow>();
      await project(paused, [live("1")], 1);
      await paused.pause();
      const other = await open<ContractRow>(
        contractFields,
        "rebuild:orderSummary:ffffffffffffffff",
      );
      expect({ resumed: other.resumed, position: other.position }).toEqual({
        resumed: false,
        position: 0,
      });
      expect(await other.table.count()).toBe(0);
      await other.abort();

      const gone = await open<ContractRow>();
      expect({ resumed: gone.resumed, position: gone.position }).toEqual({
        resumed: false,
        position: 0,
      });
      expect(await gone.table.count()).toBe(0);
      expect(await gone.checkpointStore.get(PROGRESS)).toBe(0);
      await project(gone, [live("3")], 3);
      await gone.abort();
      const ports = await openLive<ContractRow>();
      expect(withoutGenerations(await ports.checkpointStore.list())).toEqual([]);
      await ports.close();

      const afterAbort = await open<ContractRow>();
      expect(afterAbort.resumed).toBe(false);
      expect(await afterAbort.table.count()).toBe(0);
      await afterAbort.abort();
    });

    it("leaves the live table alone on abort", async () => {
      const ports = await openLive<ContractRow>();
      await ports.table.insert(live("1"));
      const aborted = await open<ContractRow>();
      await project(aborted, [live("2")], 2);
      await aborted.abort();
      expect(await ports.table.findMany()).toEqual([live("1")]);
      await ports.close();
    });

    it("creates the live table when the read model never had one, and can rebuild again", async () => {
      const first = await open<RebuiltRow>(rebuiltFields);
      await project(first, [rebuilt("1")], 1);
      await first.commit({ subscriber: SUBSCRIBER, position: 1 });
      const second = await open<RebuiltRow>(rebuiltFields);
      await project(second, [rebuilt("2")], 2);
      await second.commit({ subscriber: SUBSCRIBER, position: 2 });
      const ports = await openLive<RebuiltRow>(rebuiltFields);
      expect(await ports.table.findMany({ where: { customerId: "c-1" } })).toEqual([rebuilt("2")]);
      expect(await ports.checkpointStore.get(SUBSCRIBER)).toBe(2);
      await ports.close();
    });
  });
};
