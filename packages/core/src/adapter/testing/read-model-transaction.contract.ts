import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../contracts/logger.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import type { Adapter, ReadModelStorage } from "../adapter.ts";
import { ENVELOPE_PREFIX, storedFields } from "../storage/sealed-fields.ts";
import { type ContractRow, contractFields } from "./table.contract.ts";

/**
 * How an adapter keeps two transactions of the same subscriber apart. `per-subscriber`: a lock
 * per subscriber name, which another subscriber does not wait for and `wait: false` gives up on.
 * `single-writer`: the database lets one write transaction run at a time, so every transaction
 * waits for the one before it whatever it asked.
 */
export type TransactionLocking = "per-subscriber" | "single-writer";

/**
 * What every adapter contract that opens its own adapter needs from the harness.
 */
export interface AdapterContractArgs {
  /**
   * A fresh adapter per test, with nothing in it.
   */
  readonly create: () => Promise<Adapter>;
  /**
   * Whether the contract may run two calls at once and have one wait for the other (the default).
   * A harness that reaches the adapter through a host that cannot interleave calls from the test,
   * such as a Durable Object through `runInDurableObject`, passes `false` and covers that
   * behaviour inside the host instead.
   */
  readonly concurrent?: boolean;
}

/**
 * What `readModelTransactionContract` needs: a fresh adapter per test and how it locks.
 */
export interface ReadModelTransactionContractArgs extends AdapterContractArgs {
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
 * The behaviour every adapter's `ReadModelStorage.transact` must exhibit.
 */
export const readModelTransactionContract: ReadModelTransactionContractFunction = ({
  create,
  locking,
  concurrent = true,
}) => {
  describe("read model transaction contract", () => {
    let model: ReadModelStorage<ContractRow>;

    beforeEach(async () => {
      const adapter = await create();
      model = await adapter.createReadModel<ContractRow>({
        name: NAME,
        fields: contractFields,
        logger: silentLogger,
      });
    });

    afterEach(async () => {
      await model.close();
    });

    it("commits the rows and the checkpoint together and reads its own writes", async () => {
      const outcome = await model.transact({
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
      expect(await model.table.findMany()).toEqual([{ ...order("1"), status: "paid" }]);
      expect(await model.checkpointStore.get(SUBSCRIBER)).toBe(7);
    });

    it("rolls the rows and the checkpoint back together when the work throws", async () => {
      await model.table.upsert(order("1"));
      await model.checkpointStore.set(SUBSCRIBER, 3);
      await expect(
        model.transact({
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
      expect(await model.table.findMany()).toEqual([order("1")]);
      expect(await model.checkpointStore.get(SUBSCRIBER)).toBe(3);
    });

    it("finds the rows a write around the runtime left: a sealed field without an envelope, a personal field without its key", async () => {
      const adapter = await create();
      const customers = await adapter.createReadModel<Record<string, unknown>>({
        name: "customers",
        fields: storedFields({
          readModel: "customers",
          fields: {
            customerId: f.string().primaryKey().person(),
            email: f.string().optional().personal(),
            name: f.string().optional().personal(),
            phone: f.string().optional().personal({ clear: true }),
          },
        }),
        logger: silentLogger,
      });
      const envelope = `${ENVELOPE_PREFIX}{"person":"c"}}`;
      for (const row of [
        { customerId: "c-1", email: envelope, email__key: "k", phone: "1", phone__key: "k" },
        { customerId: "c-2", email: "in the clear", email__key: "k" },
        { customerId: "c-3", phone: "3" },
        { customerId: "c-4", email: envelope },
        { customerId: "c-5" },
        {
          customerId: "c-6",
          email: envelope,
          email__key: "k",
          name: "in the clear",
          name__key: "k",
        },
      ]) {
        await customers.table.upsert(row);
      }
      const unsettled = (limit: number) =>
        customers.transact({
          subscriber: "projection:customers",
          wait: true,
          work: (transaction) =>
            transaction.unsettled({
              sealed: ["email", "name"],
              keyed: [
                { field: "email", keyField: "email__key" },
                { field: "name", keyField: "name__key" },
                { field: "phone", keyField: "phone__key" },
              ],
              limit,
            }),
        });
      const found = await unsettled(10);
      expect(found.acquired && found.value.map((row) => row.customerId).sort()).toEqual([
        "c-2",
        "c-3",
        "c-4",
        "c-6",
      ]);
      const limited = await unsettled(2);
      expect(limited.acquired && limited.value).toHaveLength(2);
      const nothing = await customers.transact({
        subscriber: "projection:customers",
        wait: true,
        work: (transaction) => transaction.unsettled({ sealed: [], keyed: [], limit: 10 }),
      });
      expect(nothing).toEqual({ acquired: true, value: [] });
      await customers.close();
    });

    it.skipIf(!concurrent)("never runs two transactions of one subscriber at once", async () => {
      const held = gate();
      const entered = gate();
      const steps: string[] = [];
      const first = model.transact({
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
      const second = model.transact({
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

    if (locking === "per-subscriber" && concurrent) {
      it("gives up at once without waiting, and lets other subscribers through", async () => {
        const held = gate();
        const entered = gate();
        const first = model.transact({
          subscriber: SUBSCRIBER,
          wait: true,
          work: async () => {
            entered.open();
            await held.opened;
          },
        });
        await entered.opened;
        expect(
          await model.transact({ subscriber: SUBSCRIBER, wait: false, work: async () => "late" }),
        ).toEqual({ acquired: false });
        expect(
          await model.transact({
            subscriber: "projection:other",
            wait: false,
            work: async () => 1,
          }),
        ).toEqual({ acquired: true, value: 1 });
        held.open();
        await first;
        expect(
          await model.transact({ subscriber: SUBSCRIBER, wait: false, work: async () => "free" }),
        ).toEqual({ acquired: true, value: "free" });
      });
    }
  });
};
