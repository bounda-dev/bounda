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
            await checkpointStore.compareAndSet(SUBSCRIBER, 0, 1);
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
