import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { connect } from "../src/client.ts";
import { type quietRegistry, SNAPSHOT_EVERY } from "./app.ts";
import type { QuietStore } from "./test-worker.ts";

// What Cloudflare bills a Durable Object for: every row a statement writes, each index it updates
// included, every `setAlarm`, billed as one more row written, and every request, each alarm that
// runs included.
interface Bill {
  readonly written: number;
  readonly alarmsArmed: number;
  readonly requests: number;
}

interface Meter {
  cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[];
  alarmsArmed: number;
  alarmsRun: number;
}

const meter: Meter = { cursors: [], alarmsArmed: 0, alarmsRun: 0 };
const restore: (() => void)[] = [];

afterAll(() => {
  for (const undo of restore.splice(0)) undo();
});

type Stub = DurableObjectStub<InstanceType<typeof QuietStore>>;

const inside = <O extends Rpc.DurableObjectBranded & { alarm(): Promise<void> }, R>(
  stub: DurableObjectStub<O>,
  run: (instance: O, state: DurableObjectState) => R | Promise<R>,
): Promise<R> => runInDurableObject(stub, run);

const instrument = (stub: Stub): Promise<void> =>
  inside(stub, (instance, state) => {
    if (restore.length === 0) {
      const sql = Object.getPrototypeOf(state.storage.sql) as SqlStorage;
      const exec = sql.exec;
      sql.exec = function (this: SqlStorage, query: string, ...bindings: unknown[]) {
        const cursor = exec.call(this, query, ...bindings);
        meter.cursors.push(cursor);
        return cursor;
      } as SqlStorage["exec"];
      const storage = Object.getPrototypeOf(state.storage) as DurableObjectStorage;
      const setAlarm = storage.setAlarm;
      storage.setAlarm = function (this: DurableObjectStorage, ...args) {
        meter.alarmsArmed += 1;
        return setAlarm.apply(this, args);
      };
      restore.push(() => {
        sql.exec = exec;
        storage.setAlarm = setAlarm;
      });
    }
    const alarm = instance.alarm.bind(instance);
    instance.alarm = async () => {
      meter.alarmsRun += 1;
      await alarm();
    };
  });

// The object arms its alarm for now, so the runtime may run it on its own; it is done once no
// alarm is armed, or one only for later.
const settle = async (stub: Stub): Promise<void> => {
  for (;;) {
    const at = await inside(stub, (_instance, state) => state.storage.getAlarm());
    if (at === null || at > Date.now()) return;
    await inside(stub, (instance) => instance.alarm());
  }
};

const bill = (requests: number): Bill => {
  const result = {
    written: meter.cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
    alarmsArmed: meter.alarmsArmed,
    requests: requests + meter.alarmsRun,
  };
  meter.cursors = [];
  meter.alarmsArmed = 0;
  meter.alarmsRun = 0;
  return result;
};

const open = (namespace: DurableObjectNamespace<InstanceType<typeof QuietStore>>) => {
  const stub: Stub = namespace.get(namespace.newUniqueId());
  return { stub, store: connect<typeof quietRegistry>(stub) };
};

// The rows inserting one event writes in this app: the row, its primary key and its indexes.
const EVENT_ROWS = 5;
const alone: Bill = { written: EVENT_ROWS, alarmsArmed: 0, requests: 1 };

describe("what a command costs a Durable Object", () => {
  it("bills placing an order its event, its read-model row and the projection's checkpoint", async () => {
    const { stub, store } = open(env.QUIET_STORE);
    await store.commands.placeOrder({ orderId: "warm", total: 1, customer: "ada" });
    await settle(stub);
    await instrument(stub);
    bill(0);
    for (const orderId of ["o1", "o2", "o3"]) {
      await store.commands.placeOrder({ orderId, total: 10, customer: "ada" });
      await settle(stub);
      expect(bill(1)).toEqual({ written: EVENT_ROWS + 3, alarmsArmed: 0, requests: 1 });
    }
  });

  it("bills an event no read model projects for the event alone, with no alarm", async () => {
    const { stub, store } = open(env.QUIET_STORE);
    await store.commands.placeOrder({ orderId: "o", total: 1, customer: "ada" });
    await settle(stub);
    await instrument(stub);
    bill(0);
    for (let i = 0; i < 3; i += 1) {
      await store.commands.remarkOrder({ orderId: "o", remark: `r${i}` });
      await settle(stub);
      expect(bill(1)).toEqual(alone);
    }
  });

  it("moves a checkpoint at rest once a full batch of events it does not handle is waiting", async () => {
    const { stub, store } = open(env.QUIET_STORE);
    await store.commands.placeOrder({ orderId: "o", total: 1, customer: "ada" });
    await settle(stub);
    await instrument(stub);
    bill(0);
    // How many commands until the alarm runs: the one that fills the dispatcher's batch.
    const untilAlarm = async (): Promise<number> => {
      for (let count = 1; count <= 1_000; count += 1) {
        await store.commands.remarkOrder({ orderId: "o", remark: `r${count}` });
        await settle(stub);
        const paid = bill(1);
        if (paid.alarmsArmed === 0) {
          expect(paid).toEqual(alone);
          continue;
        }
        expect(paid).toEqual({ written: EVENT_ROWS + 1, alarmsArmed: 1, requests: 2 });
        return count;
      }
      throw new Error("no alarm ran");
    };
    const first = await untilAlarm();
    expect(first).toBeGreaterThan(1);
    expect(await store.getLag()).toMatchObject({ maxLag: 0 });
    expect(await untilAlarm()).toBe(first);
  });

  it("bills a long stream with snapshots only for the events that bring one", async () => {
    const { stub, store } = open(env.SNAPSHOT_STORE);
    await store.commands.placeOrder({ orderId: "o", total: 1, customer: "ada" });
    await settle(stub);
    await instrument(stub);
    bill(0);
    const bills: Bill[] = [];
    // The order is at version 1, so remark `i` brings it to version `i + 2`.
    for (let i = 0; i < 3 * SNAPSHOT_EVERY; i += 1) {
      await store.commands.remarkOrder({ orderId: "o", remark: `r${i}` });
      await settle(stub);
      bills.push(bill(1));
    }
    // The first snapshot inserts its row and its index entries, the next ones replace the row;
    // the alarm that writes each also moves the subscriber's checkpoint.
    const snapshot = (version: number): Bill => ({
      written: EVENT_ROWS + (version === SNAPSHOT_EVERY ? 3 : 1) + 1,
      alarmsArmed: 1,
      requests: 2,
    });
    expect(bills).toEqual(
      bills.map((_, i) => ((i + 2) % SNAPSHOT_EVERY === 0 ? snapshot(i + 2) : alone)),
    );
  });
});
