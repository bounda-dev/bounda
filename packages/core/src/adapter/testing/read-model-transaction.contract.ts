import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../contracts/logger.ts";
import type { Adapter, ReadModelPorts } from "../adapter.ts";
import { type ContractRow, contractFields } from "./table.contract.ts";

/**
 * How an adapter keeps two transactions of the same subscriber apart. `per-subscriber`: a lock
 * per subscriber name, which another subscriber does not wait for and `wait: false` gives up on.
 * `single-writer`: the database lets one write transaction run at a time, so every transaction
 * waits for the one before it whatever it asked.
 */
export type TransactionLocking = "per-subscriber" | "single-writer";

export interface ReadModelTransactionContractArgs {
  /**
   * A fresh adapter per test, with nothing in it.
   */
  readonly create: () => Promise<Adapter>;
  readonly locking: TransactionLocking;
}

export interface ReadModelTransactionContractFunction {
  (args: ReadModelTransactionContractArgs): void;
}

const NAME = "orderSummary";
const SUBSCRIBER = "projection:orderSummary";

const order = (orderId: string, total = 10): ContractRow => ({
  orderId,
  customerId: "c-1",
  status: "placed",
  total,
});

interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

const gate = (): Gate => {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

/**
 * The behaviour every adapter's `ReadModelPorts.transact` must exhibit: the table and the
 * checkpoint commit together, roll back together, and two transactions of one subscriber never
 * overlap.
 */
export const readModelTransactionContract: ReadModelTransactionContractFunction = ({
  create,
  locking,
}) => {
  describe("read model transaction contract", () => {
    let ports: ReadModelPorts<ContractRow>;

    beforeEach(async () => {
      const adapter = await create();
      ports = await adapter.createReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
      });
    });

    afterEach(async () => {
      await ports.close();
    });

    it("commits the rows and the checkpoint together and reads its own writes", async () => {
      const outcome = await ports.transact({
        subscriber: SUBSCRIBER,
        wait: true,
        work: async ({ table, checkpointStore }) => {
          await table.upsert(order("1"));
          await table.update({ orderId: "1" }, { status: "paid" });
          expect(await table.findOne({ orderId: "1" })).toEqual({ ...order("1"), status: "paid" });
          expect(await checkpointStore.compareAndSet(SUBSCRIBER, 0, 7)).toBe(true);
          expect(await checkpointStore.get(SUBSCRIBER)).toBe(7);
          return "done";
        },
      });
      expect(outcome).toEqual({ acquired: true, value: "done" });
      expect(await ports.table.findMany()).toEqual([{ ...order("1"), status: "paid" }]);
      expect(await ports.checkpointStore.get(SUBSCRIBER)).toBe(7);
    });

    it("rolls the rows and the checkpoint back together when the work throws", async () => {
      await ports.table.upsert(order("1"));
      await ports.checkpointStore.set(SUBSCRIBER, 3);
      await expect(
        ports.transact({
          subscriber: SUBSCRIBER,
          wait: true,
          work: async ({ table, checkpointStore }) => {
            await table.update({ orderId: "1" }, { total: 99 });
            await table.upsert(order("2"));
            await table.delete({ orderId: "1" });
            await checkpointStore.compareAndSet(SUBSCRIBER, 3, 9);
            throw new Error("projection failed");
          },
        }),
      ).rejects.toThrow("projection failed");
      expect(await ports.table.findMany()).toEqual([order("1")]);
      expect(await ports.checkpointStore.get(SUBSCRIBER)).toBe(3);
    });

    it("never runs two transactions of one subscriber at once", async () => {
      const held = gate();
      const entered = gate();
      const steps: string[] = [];
      const first = ports.transact({
        subscriber: SUBSCRIBER,
        wait: true,
        work: async ({ table }) => {
          steps.push("first in");
          await table.upsert(order("1"));
          entered.open();
          await held.opened;
          steps.push("first out");
        },
      });
      await entered.opened;
      const second = ports.transact({
        subscriber: SUBSCRIBER,
        wait: true,
        work: async ({ table }) => {
          steps.push("second in");
          expect(await table.findOne({ orderId: "1" })).toEqual(order("1"));
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      held.open();
      await Promise.all([first, second]);
      expect(steps).toEqual(["first in", "first out", "second in"]);
    });

    if (locking === "per-subscriber") {
      it("gives up at once without waiting, and lets other subscribers through", async () => {
        const held = gate();
        const entered = gate();
        const first = ports.transact({
          subscriber: SUBSCRIBER,
          wait: true,
          work: async () => {
            entered.open();
            await held.opened;
          },
        });
        await entered.opened;
        expect(
          await ports.transact({ subscriber: SUBSCRIBER, wait: false, work: async () => "late" }),
        ).toEqual({ acquired: false });
        expect(
          await ports.transact({
            subscriber: "projection:other",
            wait: false,
            work: async () => 1,
          }),
        ).toEqual({ acquired: true, value: 1 });
        held.open();
        await first;
        expect(
          await ports.transact({ subscriber: SUBSCRIBER, wait: false, work: async () => "free" }),
        ).toEqual({ acquired: true, value: "free" });
      });
    }
  });
};
