import { describe, expect, it } from "vitest";
import { createFixedClock, type FixedClock } from "../../contracts/clock.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { createRecordingLogger, eventually } from "../test-support.ts";
import type { CheckpointedSubscriber, Delivery } from "./delivery.ts";
import { createDispatcher, type DispatcherCatchUp, type Subscriber } from "./dispatcher.ts";

interface Fake extends CheckpointedSubscriber {
  at: number;
  readonly deliveries: boolean[];
}

const fake = (
  name: string,
  reacts: readonly string[],
  deliver: (self: Fake) => Promise<Delivery>,
): Fake => {
  const self: Fake = {
    name,
    kind: "projection",
    at: 0,
    deliveries: [],
    reactsTo: (type) => reacts.includes(type),
    position: async () => self.at,
    deliver: async ({ wait }) => {
      self.deliveries.push(wait);
      return deliver(self);
    },
  };
  return self;
};

const advancing =
  (to: number) =>
  async (self: Fake): Promise<Delivery> => {
    self.at = to;
    return { outcome: "advanced" };
  };

const busy = async (): Promise<Delivery> => ({ outcome: "busy" });

const failed = async (): Promise<Delivery> => ({
  outcome: "failed",
  failure: { position: 1, eventId: "e-1", eventType: "OrderPlaced", message: "boom" },
});

const setUp = async (
  subscribers: readonly (Subscriber | CheckpointedSubscriber)[],
  catchUp?: DispatcherCatchUp,
) => {
  const { eventStore, checkpointStore } = await memory().createStorage({ logger: silentLogger });
  const clock = createFixedClock();
  const { logger, entries } = createRecordingLogger();
  const dispatcher = createDispatcher({
    clock,
    eventStore,
    checkpointStore,
    subscribers,
    batchSize: 10,
    pollIntervalMs: 100,
    ...(catchUp === undefined ? {} : { catchUp }),
    logger,
  });
  return { clock, dispatcher, entries };
};

const timeToSettle = async (
  clock: FixedClock,
  waiting: Promise<unknown>,
  step: number,
): Promise<number> => {
  const started = clock.now().getTime();
  let settled = false;
  void waiting.then(() => {
    settled = true;
  });
  for (;;) {
    await eventually(() => expect(settled || clock.pending() === 1).toBe(true));
    if (settled) return clock.now().getTime() - started;
    clock.advance(step);
  }
};

describe("catchUpThrough", () => {
  it("waits only for the projections that react to one of the command's events", async () => {
    const orders = fake("projection:orders", ["OrderPlaced"], advancing(7));
    const customers = fake("projection:customers", ["CustomerRegistered"], advancing(7));
    let policies = 0;
    const policy: Subscriber = {
      name: "policies",
      kind: "policy",
      process: async () => {
        policies += 1;
        return true;
      },
    };
    const { dispatcher } = await setUp([orders, customers, policy]);
    expect(
      await dispatcher.catchUpThrough({ position: 7, eventTypes: ["OrderPlaced", "OrderTagged"] }),
    ).toBe(true);
    expect(orders.deliveries).toEqual([false]);
    expect(customers.deliveries).toEqual([]);
    expect(policies).toBe(0);
  });

  it("does nothing for a projection already past the command's position", async () => {
    const orders = fake("projection:orders", ["OrderPlaced"], advancing(9));
    orders.at = 9;
    const { dispatcher } = await setUp([orders]);
    expect(await dispatcher.catchUpThrough({ position: 7, eventTypes: ["OrderPlaced"] })).toBe(
      true,
    );
    expect(orders.deliveries).toEqual([]);
  });

  it("delivers without waiting for the lock until the projection reaches the position", async () => {
    let batches = 0;
    const orders = fake("projection:orders", ["OrderPlaced"], async (self) => {
      batches += 1;
      self.at += 3;
      return { outcome: "advanced" };
    });
    const { dispatcher } = await setUp([orders]);
    expect(await dispatcher.catchUpThrough({ position: 7, eventTypes: ["OrderPlaced"] })).toBe(
      true,
    );
    expect(batches).toBe(3);
    expect(orders.deliveries).toEqual([false, false, false]);
  });

  it("reads the checkpoint again while another process holds the projection, until it gets there", async () => {
    const orders = fake("projection:orders", ["OrderPlaced"], busy);
    const { clock, dispatcher } = await setUp([orders], { timeoutMs: 2_000, pollIntervalMs: 15 });
    let settled: boolean | undefined;
    void dispatcher.catchUpThrough({ position: 7, eventTypes: ["OrderPlaced"] }).then((reached) => {
      settled = reached;
    });
    await eventually(() => expect(clock.pending()).toBe(1));
    clock.advance(14);
    expect(clock.pending()).toBe(1);
    orders.at = 7;
    clock.advance(1);
    await eventually(() => expect(settled).toBe(true));
    expect(orders.deliveries).toEqual([false]);
  });

  it("gives up once the timeout is up, says which read models are behind, and lets the caller go on", async () => {
    const orders = fake("projection:orders", ["OrderPlaced"], busy);
    const { clock, dispatcher, entries } = await setUp([orders], {
      timeoutMs: 2_000,
      pollIntervalMs: 20,
    });
    const waiting = dispatcher.catchUpThrough({ position: 7, eventTypes: ["OrderPlaced"] });
    expect(await timeToSettle(clock, waiting, 20)).toBe(2_000);
    expect(await waiting).toBe(false);
    expect(entries).toEqual([
      {
        level: "warn",
        message: "read models did not catch up with the command in time",
        fields: { position: 7, subscribers: ["projection:orders"], timeoutMs: 2_000 },
      },
    ]);
  });

  it("waits two seconds at most, reading the checkpoint every 15 ms, unless told otherwise", async () => {
    const orders = fake("projection:orders", ["OrderPlaced"], busy);
    const { clock, dispatcher } = await setUp([orders]);
    const waiting = dispatcher.catchUpThrough({ position: 7, eventTypes: ["OrderPlaced"] });
    expect(await timeToSettle(clock, waiting, 15)).toBe(2_010);
    expect(orders.deliveries).toHaveLength(134);
  });

  it("stops waiting for a projection whose batch fails", async () => {
    const orders = fake("projection:orders", ["OrderPlaced"], failed);
    const { dispatcher, entries } = await setUp([orders]);
    expect(await dispatcher.catchUpThrough({ position: 7, eventTypes: ["OrderPlaced"] })).toBe(
      false,
    );
    expect(orders.deliveries).toEqual([false]);
    expect(entries.map(({ message }) => message)).toEqual([
      "read models did not catch up with the command in time",
    ]);
  });

  it("does not wait for a projection that backs off after failing, until its retry is due", async () => {
    const orders = fake("projection:orders", ["OrderPlaced"], failed);
    const { clock, dispatcher } = await setUp([orders]);
    const through = { position: 7, eventTypes: ["OrderPlaced"] };
    expect(await dispatcher.catchUpThrough(through)).toBe(false);
    expect(await dispatcher.catchUpThrough(through)).toBe(false);
    expect(orders.deliveries).toEqual([false]);
    expect((await dispatcher.getLag()).subscribers[0]?.failing?.attempts).toBe(1);
    clock.advance(1_000);
    expect(await dispatcher.catchUpThrough(through)).toBe(false);
    expect(orders.deliveries).toEqual([false, false]);
  });

  it("does not queue behind a pass in flight", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = fake("projection:slow", [], async (self) => {
      await held;
      self.at = 1;
      return { outcome: "advanced" };
    });
    const orders = fake("projection:orders", ["OrderPlaced"], advancing(7));
    const { dispatcher } = await setUp([slow, orders]);
    const pass = dispatcher.processOnce();
    await eventually(() => expect(slow.deliveries).toEqual([true]));
    expect(await dispatcher.catchUpThrough({ position: 7, eventTypes: ["OrderPlaced"] })).toBe(
      true,
    );
    release();
    await pass;
  });
});
