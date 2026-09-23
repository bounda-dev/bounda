import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { silentLogger } from "@bounda-dev/core";
import { contractFields } from "@bounda-dev/core/adapter/testing";
import { describe, expect, it } from "vitest";
import { durableObjectAdapter } from "../src/adapter.ts";

interface Row {
  readonly orderId: string;
  readonly customerId: string;
  readonly status: string;
  readonly total: number;
}

const fresh = () => env.STORE.get(env.STORE.newUniqueId());
const SUBSCRIBER = "projection:orderSummary";
const order = (orderId: string): Row => ({
  orderId,
  customerId: "c-1",
  status: "placed",
  total: 1,
});

const openPorts = (storage: DurableObjectState["storage"]) =>
  durableObjectAdapter({ storage, options: {} }).createReadModel<Row>({
    name: "orderSummary",
    fields: contractFields,
    logger: silentLogger,
  });

describe("read model transactions in a Durable Object", () => {
  it("commits the rows and the checkpoint together and rolls both back on a throw", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const ports = await openPorts(state.storage);
      expect(
        await ports.transact({
          subscriber: SUBSCRIBER,
          wait: false,
          work: async ({ table, checkpointStore }) => {
            await table.upsert(order("1"));
            await table.update({ orderId: "1" }, { total: 2 });
            expect(await table.findOne({ orderId: "1" })).toEqual({ ...order("1"), total: 2 });
            await table.update({ orderId: "1" }, { total: 1 });
            await checkpointStore.compareAndSet(SUBSCRIBER, 0, 1);
            expect(await checkpointStore.get(SUBSCRIBER)).toBe(1);
            return "kept";
          },
        }),
      ).toEqual({ acquired: true, value: "kept" });
      await expect(
        ports.transact({
          subscriber: SUBSCRIBER,
          wait: false,
          work: async ({ table, checkpointStore, client }) => {
            await table.upsert(order("2"));
            await checkpointStore.compareAndSet(SUBSCRIBER, 1, 2);
            (client.raw as SqlStorage).exec(
              `UPDATE "bounda_order_summary" SET "status" = 'paid' WHERE "order_id" = '1'`,
            );
            throw new Error("projection failed");
          },
        }),
      ).rejects.toThrow("projection failed");
      expect(await ports.table.findMany()).toEqual([order("1")]);
      expect(await ports.checkpointStore.get(SUBSCRIBER)).toBe(1);
    });
  });

  it("never runs two transactions of one subscriber at once", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const ports = await openPorts(state.storage);
      const steps: string[] = [];
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = ports.transact({
        subscriber: SUBSCRIBER,
        wait: true,
        work: async ({ table }) => {
          steps.push("first in");
          await table.upsert(order("1"));
          await held;
          steps.push("first out");
        },
      });
      const second = ports.transact({
        subscriber: SUBSCRIBER,
        wait: true,
        work: async ({ table }) => {
          steps.push("second in");
          expect(await table.findOne({ orderId: "1" })).toEqual(order("1"));
        },
      });
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      release();
      await Promise.all([first, second]);
      expect(steps).toEqual(["first in", "first out", "second in"]);
    });
  });

  it("lets a rebuild swap only once the projection batch in flight has committed", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const adapter = durableObjectAdapter({ storage: state.storage, options: {} });
      const ports = await openPorts(state.storage);
      const rebuild = await adapter.rebuildReadModel<Row>({
        name: "orderSummary",
        fields: contractFields,
        logger: silentLogger,
        progress: "rebuild:orderSummary:1",
      });
      await rebuild.transact(async ({ table, checkpointStore }) => {
        await table.upsert({ ...order("1"), total: 99 });
        await checkpointStore.set("rebuild:orderSummary:1", 5);
      });
      const steps: string[] = [];
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const batch = ports.transact({
        subscriber: SUBSCRIBER,
        wait: true,
        work: async ({ table }) => {
          await table.upsert({ ...order("1"), total: 7 });
          await held;
          steps.push("batch done");
        },
      });
      const committing = rebuild
        .commit({ subscriber: SUBSCRIBER, position: 5 })
        .then(() => steps.push("committed"));
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      release();
      await Promise.all([batch, committing]);
      expect(steps).toEqual(["batch done", "committed"]);
      expect(await ports.table.findMany()).toEqual([{ ...order("1"), total: 99 }]);
      expect(await ports.checkpointStore.get(SUBSCRIBER)).toBe(5);
    });
  });

  it("completes a batch while a timer is pending outside it", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const ports = await openPorts(state.storage);
      const fired: string[] = [];
      const timer = new Promise<void>((resolve) =>
        setTimeout(() => {
          fired.push("timer");
          resolve();
        }, 1),
      );
      await ports.transact({
        subscriber: SUBSCRIBER,
        wait: false,
        work: async ({ table }) => {
          for (let index = 0; index < 200; index += 1) await table.upsert(order(`${index}`));
        },
      });
      await timer;
      expect({ fired, rows: await ports.table.count() }).toEqual({ fired: ["timer"], rows: 200 });
    });
  });
});
