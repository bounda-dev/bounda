import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { PendingEvent } from "../../adapter/storage/event-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { type Logger, silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../../modules/bounda-events.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import {
  BACKFILL_EXPIRY_MS,
  BACKFILL_FOLLOW_INTERVAL_MS,
  BACKFILL_LEASE_MS,
  BACKFILL_PREFIX,
  createPersonalDataBackfill,
} from "./backfill.ts";
import { HOLD_MS } from "./hold.ts";
import { createPersonalKeyWrapping } from "./wrapped-keys.ts";

const START = new Date("2026-06-01T00:00:00.000Z");

const aggregates = {
  byName: {
    customer: {
      name: "customer",
      snapshot: null,
      eventsByType: { CustomerRegistered: { personal: { person: null, fields: ["email"] } } },
    },
    order: {
      name: "order",
      snapshot: null,
      eventsByType: { OrderPlaced: { personal: { person: "customerId", fields: ["address"] } } },
    },
  },
  commandsByType: {
    ShipOrder: { command: { personal: { person: "customerId", fields: ["address"] } } },
  },
} as unknown as AggregatesRuntime;

const processes = { byName: {} } as unknown as Pick<ProcessesRuntime, "byName">;

const metadata = {
  correlationId: "c",
  causationId: "c",
  commandId: "c",
  depth: 0,
  schemaVersion: 1,
  system: false,
};

const pending = (
  aggregateType: string,
  aggregateId: string,
  type: string,
  payload: unknown,
): PendingEvent => ({
  id: `${aggregateType}-${aggregateId}-${type}`,
  aggregateType,
  aggregateId,
  version: 1,
  type,
  payload,
  timestamp: START.toISOString(),
  metadata,
  person: aggregateType === BOUNDA_AGGREGATE ? aggregateId : null,
});

const recording = () => {
  const logs: [string, string, unknown][] = [];
  const logger: Logger = {
    ...silentLogger,
    info: (message, fields) => logs.push(["info", message, fields]),
    warn: (message, fields) => logs.push(["warn", message, fields]),
    error: (message, fields) => logs.push(["error", message, fields]),
  };
  return { logs, logger };
};

interface WalkerArgs {
  readonly storage: Storage;
  readonly marks?: string;
  readonly batchSize?: number;
  readonly logger?: Logger;
}

const walker = ({ storage, marks = "m1", batchSize = 10, logger = silentLogger }: WalkerArgs) => {
  const clock = createFixedClock(START);
  const backfill = createPersonalDataBackfill({
    storage,
    aggregates,
    processes,
    wrapping: createPersonalKeyWrapping({ wrapper: null, clock }),
    marks,
    batchSize,
    recordsActivity: false,
    clock,
    logger,
  });
  return { backfill, clock };
};

const append = async (storage: Storage, ...events: PendingEvent[]) => {
  for (const event of events) {
    await storage.eventStore.append({
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      expectedVersion: 0,
      events: [event],
    });
  }
};

const rows = async (storage: Storage) =>
  Object.fromEntries(
    (await storage.checkpointStore.list())
      .filter(({ subscriber }) => subscriber.startsWith(BACKFILL_PREFIX))
      .map(({ subscriber, position }) => [subscriber.slice(BACKFILL_PREFIX.length), position]),
  );

describe("the backfill's walk", () => {
  it("walks a batch a pass, then the stores, and logs what it sealed once it catches up", async () => {
    const storage = await memory().createStorage();
    await append(
      storage,
      pending("customer", "c-1", "CustomerRegistered", { email: "a" }),
      pending("customer", "c-2", "CustomerRegistered", { email: "b" }),
      pending(BOUNDA_AGGREGATE, "c-2", PERSONAL_DATA_FORGOTTEN_EVENT, { personId: "c-2" }),
      pending("order", "o-1", "OrderPlaced", { customerId: "", address: "x" }),
    );
    await storage.scheduler.schedule({
      dedupeKey: "s",
      command: { type: "ShipOrder", aggregateId: "o-1", payload: { customerId: "", address: "x" } },
      executeAt: START,
      context: { correlationId: "c", causationId: "c", depth: 0 },
    });
    const { logs, logger } = recording();
    const { backfill } = walker({ storage, batchSize: 2, logger });
    expect(await backfill.status(4)).toEqual({ position: 0, caughtUp: false });
    expect(await backfill.nextDueAt()).toEqual(START);

    expect(await backfill.sweep(START)).toBe(2);
    expect(await backfill.status(4)).toEqual({ position: 2, caughtUp: false });
    expect(await backfill.sweep(START)).toBe(2);
    expect(await backfill.sweep(START)).toBe(0);
    expect(await backfill.status(4)).toEqual({ position: 4, caughtUp: true });
    expect(await backfill.nextDueAt()).toBeNull();
    expect(await rows(storage)).toEqual({
      "m1:started": START.getTime(),
      "m1:position": 4,
      "m1:stores": START.getTime(),
      "m1:lease": START.getTime() + BACKFILL_LEASE_MS,
    });
    expect(logs).toEqual([
      [
        "warn",
        "personal data of persons forgotten before it was marked is sealed for good; rebuild the read models that project it",
        {
          events: 1,
          eventTypes: ["customer.CustomerRegistered"],
          afterPosition: 0,
          throughPosition: 2,
        },
      ],
      [
        "warn",
        "personal data written before its marks names no person and stays in the clear",
        { events: 1, eventTypes: ["order.OrderPlaced"], afterPosition: 2, throughPosition: 4 },
      ],
      [
        "warn",
        "commands stored before their marks name no person and stay in the clear",
        { scheduledCommands: 1, deadLetters: 0, commandTypes: ["ShipOrder"] },
      ],
      [
        "info",
        "personal data written before its marks is sealed",
        {
          marks: "m1",
          events: 2,
          discarded: 1,
          unsealable: 2,
          scheduledCommands: 0,
          deadLetters: 0,
        },
      ],
    ]);
  });

  it("rests a follow interval at the head, then seals what came in the clear and goes through the stores again", async () => {
    const storage = await memory().createStorage();
    const { logs, logger } = recording();
    const { backfill } = walker({ storage, logger });
    expect(await backfill.sweep(START)).toBe(0);
    await append(storage, pending("customer", "c-1", "CustomerRegistered", { email: "a" }));
    const soon = new Date(START.getTime() + BACKFILL_FOLLOW_INTERVAL_MS - 1);
    expect(await backfill.sweep(soon)).toBe(0);
    const later = new Date(START.getTime() + BACKFILL_FOLLOW_INTERVAL_MS);
    expect(await backfill.sweep(later)).toBe(1);
    expect((await rows(storage))["m1:stores"]).toBe(later.getTime());
    expect(logs.filter(([level]) => level === "info")).toEqual([
      [
        "info",
        "personal data written before its marks is sealed",
        expect.objectContaining({ events: 0 }),
      ],
      [
        "info",
        "personal data written before its marks is sealed",
        expect.objectContaining({ events: 1 }),
      ],
    ]);
    const quiet = new Date(later.getTime() + BACKFILL_FOLLOW_INTERVAL_MS);
    await append(storage, pending("customer", "c-2", "CustomerNoted", {}));
    expect(await backfill.sweep(quiet)).toBe(1);
    expect((await rows(storage))["m1:stores"]).toBe(later.getTime());
  });

  it("lets one instance walk, renewing its lease once half of it is spent, and hands it over when given back", async () => {
    const storage = await memory().createStorage();
    await append(storage, pending("customer", "c-1", "CustomerRegistered", { email: "a" }));
    const one = walker({ storage, batchSize: 1 });
    const other = walker({ storage, batchSize: 1 });
    expect(await one.backfill.sweep(START)).toBe(1);
    expect(await other.backfill.sweep(START)).toBe(0);
    expect(await other.backfill.nextDueAt()).toEqual(new Date(START.getTime() + BACKFILL_LEASE_MS));
    const half = START.getTime() + BACKFILL_LEASE_MS / 2;
    expect(await one.backfill.sweep(new Date(START.getTime() + 1))).toBe(0);
    expect((await rows(storage))["m1:lease"]).toBe(START.getTime() + BACKFILL_LEASE_MS);
    await one.backfill.sweep(new Date(half + 1));
    expect((await rows(storage))["m1:lease"]).toBe(half + 1 + BACKFILL_LEASE_MS);
    one.clock.set(new Date(half + 2));
    await one.backfill.release();
    expect((await rows(storage))["m1:lease"]).toBe(half + 2);
    await one.backfill.release();
    expect(await other.backfill.sweep(new Date(half + 3))).toBe(0);
    expect((await rows(storage))["m1:lease"]).toBe(half + 3 + BACKFILL_LEASE_MS);
  });

  it("takes a lease that lapsed, or one set by a clock ahead by more than a lease", async () => {
    const storage = await memory().createStorage();
    const { backfill } = walker({ storage });
    const lease = `${BACKFILL_PREFIX}m1:lease`;
    await storage.checkpointStore.set(lease, START.getTime() + BACKFILL_LEASE_MS + 1);
    await backfill.sweep(START);
    expect((await rows(storage))["m1:lease"]).toBe(START.getTime() + BACKFILL_LEASE_MS);
    const other = walker({ storage });
    await storage.checkpointStore.set(lease, START.getTime());
    await other.backfill.sweep(START);
    expect((await rows(storage))["m1:lease"]).toBe(START.getTime() + BACKFILL_LEASE_MS);
  });

  it("stops at a position another instance moved, walking nothing past it", async () => {
    const storage = await memory().createStorage();
    await append(storage, pending("customer", "c-1", "CustomerRegistered", { email: "a" }));
    const moving: Storage = {
      ...storage,
      checkpointStore: {
        ...storage.checkpointStore,
        compareAndSet: async (subscriber, expected, position) =>
          subscriber.endsWith(":position")
            ? false
            : storage.checkpointStore.compareAndSet(subscriber, expected, position),
      },
    };
    const { backfill } = walker({ storage: moving });
    expect(await backfill.sweep(START)).toBe(0);
    expect((await rows(storage))["m1:stores"]).toBeUndefined();
    expect(await backfill.nextDueAt()).toEqual(START);
  });

  it("holds the walk on a failure for every instance, waiting for another's hold, and clears it once it succeeds", async () => {
    const base = await memory().createStorage();
    await append(base, pending("customer", "c-1", "CustomerRegistered", { email: "a" }));
    let down = true;
    const storage: Storage = {
      ...base,
      transact: (work) => (down ? Promise.reject(new Error("store is down")) : base.transact(work)),
    };
    const { logs, logger } = recording();
    const one = walker({ storage, logger });
    expect(await one.backfill.sweep(START)).toBe(0);
    expect(logs).toContainEqual([
      "error",
      "personal data written before its marks could not be sealed",
      expect.objectContaining({ message: "store is down" }),
    ]);
    expect(await rows(base)).toMatchObject({
      "m1:attempts": 1,
      "m1:held-until": START.getTime() + HOLD_MS,
    });
    expect(await one.backfill.nextDueAt()).toEqual(new Date(START.getTime() + HOLD_MS));
    expect(await one.backfill.sweep(new Date(START.getTime() + HOLD_MS - 1))).toBe(0);

    const other = walker({ storage });
    await base.checkpointStore.remove(`${BACKFILL_PREFIX}m1:lease`);
    expect(await other.backfill.sweep(new Date(START.getTime() + 1))).toBe(0);
    expect(await rows(base)).toMatchObject({ "m1:attempts": 1 });

    const due = new Date(START.getTime() + HOLD_MS);
    expect(await one.backfill.sweep(due)).toBe(0);
    expect(await rows(base)).toMatchObject({
      "m1:attempts": 2,
      "m1:held-until": due.getTime() + 2 * HOLD_MS,
    });
    down = false;
    expect(await one.backfill.sweep(new Date(due.getTime() + 2 * HOLD_MS))).toBe(1);
    const left = await rows(base);
    expect(left).not.toHaveProperty("m1:attempts");
    expect(left).not.toHaveProperty("m1:held-until");
  });

  it("pauses in this instance when the store cannot keep the hold", async () => {
    const base = await memory().createStorage();
    let broken = true;
    const storage: Storage = {
      ...base,
      checkpointStore: {
        ...base.checkpointStore,
        get: (subscriber) =>
          broken
            ? Promise.reject(new Error("checkpoints are down"))
            : base.checkpointStore.get(subscriber),
      },
    };
    const { logs, logger } = recording();
    const { backfill } = walker({ storage, logger });
    expect(await backfill.sweep(START)).toBe(0);
    expect(logs.map(([, message]) => message)).toEqual([
      "personal data written before its marks could not be sealed",
      "personal data backfill could not be held",
    ]);
    broken = false;
    expect(await backfill.sweep(new Date(START.getTime() + 1))).toBe(0);
    expect(await backfill.nextDueAt()).toEqual(new Date(START.getTime() + HOLD_MS));
    expect(await backfill.sweep(new Date(START.getTime() + HOLD_MS))).toBe(0);
    expect(await backfill.nextDueAt()).toBeNull();
  });

  it("logs a lease it could not give back, and gives none back it does not hold", async () => {
    const base = await memory().createStorage();
    let refusing = false;
    const storage: Storage = {
      ...base,
      checkpointStore: {
        ...base.checkpointStore,
        compareAndSet: (subscriber, expected, position) =>
          refusing
            ? Promise.reject(new Error("cannot write"))
            : base.checkpointStore.compareAndSet(subscriber, expected, position),
      },
    };
    const { logs, logger } = recording();
    const idle = walker({ storage, logger });
    await idle.backfill.release();
    expect(logs).toEqual([]);
    const { backfill } = walker({ storage, logger });
    await backfill.sweep(START);
    refusing = true;
    await backfill.release();
    expect(logs).toContainEqual([
      "error",
      "personal data backfill could not give its lease back",
      expect.objectContaining({ message: "cannot write" }),
    ]);
  });

  it("removes the rows of marks no instance has run for a while, and keeps the others", async () => {
    const storage = await memory().createStorage();
    const at = START.getTime();
    const set = (row: string, value: number) =>
      storage.checkpointStore.set(`${BACKFILL_PREFIX}${row}`, value);
    await set("old:lease", at - BACKFILL_EXPIRY_MS);
    await set("old:position", 9);
    await set("recent:lease", at - BACKFILL_EXPIRY_MS + 1);
    await set("recent:position", 9);
    await set("leaseless:position", 9);
    await storage.checkpointStore.set("policies", 3);
    const { backfill } = walker({ storage });
    await backfill.sweep(START);
    expect(Object.keys(await rows(storage)).sort()).toEqual([
      "m1:lease",
      "m1:started",
      "m1:stores",
      "recent:lease",
      "recent:position",
    ]);
    expect(await storage.checkpointStore.get("policies")).toBe(3);
  });

  it("keeps when it started from the first pass under its marks", async () => {
    const storage = await memory().createStorage();
    await walker({ storage }).backfill.sweep(START);
    const later = walker({ storage });
    await storage.checkpointStore.remove(`${BACKFILL_PREFIX}m1:lease`);
    await later.backfill.sweep(new Date(START.getTime() + 5_000));
    expect((await rows(storage))["m1:started"]).toBe(START.getTime());
  });
});
