import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { Snapshot } from "../../adapter/storage/snapshot-store.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { resolveConfig } from "../../config/schema.ts";
import { SnapshotError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { Registry } from "../../modules/registry.ts";
import { ATTRIBUTES, METRICS } from "../telemetry.ts";
import { type FakeTelemetry, installFakeTelemetry } from "../telemetry-fake.ts";
import { choosePorts, createRecordingLogger, orderAggregate } from "../test-support.ts";
import { buildAggregates } from "./build-aggregates.ts";
import { createAggregateLoader } from "./load-aggregate.ts";
import { serializeFold } from "./snapshot-codec.ts";

let telemetry: FakeTelemetry | undefined;

afterEach(() => {
  telemetry?.restore();
  telemetry = undefined;
});

interface SetUpArgs {
  readonly every?: number;
  readonly verify?: number;
  readonly strict?: boolean;
  readonly snapshots?: boolean;
}

const stream = { aggregateType: "order", aggregateId: "1" };
const paid = { status: "paid", total: 10 };

const setUp = async ({
  every = 2,
  verify = 0,
  strict = false,
  snapshots = true,
}: SetUpArgs = {}) => {
  telemetry = installFakeTelemetry();
  const evolves = {
    placed: vi.fn(orderAggregate.events.orderPlaced.evolve),
    paid: vi.fn(orderAggregate.events.orderPaid.evolve),
    archived: vi.fn(orderAggregate.events.orderArchived.evolve),
  };
  const registry: Registry = {
    aggregates: {
      order: {
        ...orderAggregate,
        stateFingerprint: "fp",
        events: {
          orderPlaced: { ...orderAggregate.events.orderPlaced, evolve: evolves.placed },
          orderPaid: { ...orderAggregate.events.orderPaid, evolve: evolves.paid },
          orderArchived: { evolve: evolves.archived },
        },
      },
    },
    readModels: {},
  };
  const adapter = memory();
  const config = resolveConfig({
    storage: adapter,
    ports: { order: { notifier: "silent" } },
    runtime: snapshots ? { overrides: { order: { snapshot: { every, verify } } } } : {},
  });
  const aggregate = buildAggregates({ registry, ports: choosePorts(registry, config), config })
    .byName.order;
  if (aggregate === undefined) throw new Error("no order aggregate");
  const storage = await adapter.createStorage({ logger: { ...createRecordingLogger().logger } });
  const snapshotStore = {
    get: vi.fn(storage.snapshotStore.get),
    put: vi.fn(storage.snapshotStore.put),
    remove: vi.fn(storage.snapshotStore.remove),
    forget: vi.fn(storage.snapshotStore.forget),
  };
  const { logger, entries } = createRecordingLogger();
  const loader = createAggregateLoader({ snapshotStore, logger, strict });
  const append = async (...events: readonly (readonly [number, string, unknown])[]) => {
    await storage.eventStore.append({
      ...stream,
      expectedVersion: (events[0]?.[0] ?? 1) - 1,
      events: events.map(([version, type, payload]) =>
        pendingEvent({ aggregateId: "1", version, type, payload }),
      ),
    });
  };
  await append([1, "OrderPlaced", { total: 10 }], [2, "OrderPaid", { method: "card" }]);
  const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
    ...stream,
    version: 2,
    fingerprint: "fp:1",
    state: serializeFold({ state: paid, created: true, openedWithout: null }),
    persons: [],
    ...overrides,
  });
  const load = (eventStore: EventStore = storage.eventStore) =>
    loader.load({ aggregate, aggregateId: "1", eventStore });
  const outcomes = () =>
    (telemetry?.counts ?? [])
      .filter((count) => count.metric === METRICS.snapshots)
      .map((count) => count.attributes[ATTRIBUTES.outcome]);
  return { storage, snapshotStore, evolves, entries, append, snapshot, load, outcomes };
};

describe("createAggregateLoader", () => {
  it("folds an aggregate without snapshots from its first event, asking no store", async () => {
    const { snapshotStore, load, outcomes } = await setUp({ snapshots: false });
    expect(await load()).toEqual({
      folded: { state: paid, created: true, openedWithout: null },
      version: 2,
      persons: [],
    });
    expect(snapshotStore.get).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([]);
  });

  it("folds from the first event while a stream has no snapshot", async () => {
    const { load, outcomes, evolves } = await setUp();
    expect(await load()).toMatchObject({ folded: { state: paid }, version: 2 });
    expect(evolves.placed).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual(["missing"]);
    expect(telemetry?.counts[0]?.attributes).toEqual({
      [ATTRIBUTES.aggregateType]: "order",
      [ATTRIBUTES.outcome]: "missing",
    });
    expect(telemetry?.instruments).toContainEqual({
      metric: METRICS.snapshots,
      description: "Loads of an aggregate with snapshots, by what its snapshot was worth",
      unit: "{load}",
    });
  });

  it("loads from the snapshot only the events after it", async () => {
    const { storage, snapshot, append, load, outcomes, evolves } = await setUp();
    await storage.snapshotStore.put(snapshot());
    await append([3, "OrderArchived", {}]);
    expect(await load()).toEqual({
      folded: { state: paid, created: true, openedWithout: null },
      version: 3,
      persons: [],
    });
    expect(evolves.placed).not.toHaveBeenCalled();
    expect(evolves.paid).not.toHaveBeenCalled();
    expect(evolves.archived).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual(["used"]);
  });

  it("ignores, but keeps, a snapshot taken by other code", async () => {
    const { storage, snapshot, load, outcomes, evolves } = await setUp();
    await storage.snapshotStore.put(snapshot({ fingerprint: "fp:2" }));
    expect(await load()).toMatchObject({ folded: { state: paid }, version: 2 });
    expect(evolves.placed).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual(["stale"]);
    expect(await storage.snapshotStore.get(stream)).toEqual(snapshot({ fingerprint: "fp:2" }));
  });

  it("drops a snapshot it cannot read and folds from the first event", async () => {
    const { storage, snapshot, load, outcomes, entries } = await setUp();
    await storage.snapshotStore.put(snapshot({ state: "[1]" }));
    expect(await load()).toMatchObject({ folded: { state: paid }, version: 2 });
    expect(outcomes()).toEqual(["unreadable"]);
    expect(await storage.snapshotStore.get(stream)).toBeNull();
    expect(entries).toEqual([
      {
        level: "warn",
        message: "snapshot could not be read; the stream is folded from its first event",
        fields: expect.objectContaining({
          ...stream,
          version: 2,
          message: "not a serialized fold",
        }),
      },
    ]);
  });

  it("drops a snapshot past the stream's head and folds from the first event", async () => {
    const { storage, snapshot, load, outcomes, entries } = await setUp();
    await storage.snapshotStore.put(snapshot({ version: 5 }));
    expect(await load()).toMatchObject({ folded: { state: paid }, version: 2 });
    expect(outcomes()).toEqual(["ahead"]);
    expect(await storage.snapshotStore.get(stream)).toBeNull();
    expect(entries).toEqual([
      {
        level: "warn",
        message: "snapshot is past the stream's head; the stream is folded from its first event",
        fields: { ...stream, version: 5, head: 2 },
      },
    ]);
  });

  it("checks the share of loads `verify` asks for against the whole stream", async () => {
    const { storage, snapshot, load, outcomes } = await setUp({ verify: 0.5 });
    await storage.snapshotStore.put(snapshot());
    for (let turn = 0; turn < 4; turn += 1) {
      expect(await load()).toMatchObject({ folded: { state: paid }, version: 2 });
    }
    expect(outcomes()).toEqual(["used", "verified", "used", "verified"]);
  });

  it("checks every load in strict mode", async () => {
    const { storage, snapshot, load, outcomes } = await setUp({ strict: true });
    await storage.snapshotStore.put(snapshot());
    await load();
    await load();
    expect(outcomes()).toEqual(["verified", "verified"]);
  });

  it("checks against the stream as it was loaded, not as it moved since", async () => {
    const { storage, snapshot, append, load, outcomes } = await setUp({ verify: 1 });
    await storage.snapshotStore.put(snapshot());
    let moved = false;
    const moving: EventStore = {
      ...storage.eventStore,
      load: async (args) => {
        if (args.fromVersion === undefined && !moved) {
          moved = true;
          await append([3, "OrderPlaced", { total: 99 }]);
        }
        return storage.eventStore.load(args);
      },
    };
    expect(await load(moving)).toEqual({
      folded: { state: paid, created: true, openedWithout: null },
      version: 2,
      persons: [],
    });
    expect(outcomes()).toEqual(["verified"]);
  });

  it("drops a snapshot that folds to another state and answers with the stream's", async () => {
    const { storage, snapshot, append, load, outcomes, entries, evolves } = await setUp({
      verify: 1,
    });
    await storage.snapshotStore.put(
      snapshot({
        state: serializeFold({ state: { ...paid, total: 99 }, created: true, openedWithout: null }),
      }),
    );
    await append([3, "OrderArchived", {}]);
    expect(await load()).toEqual({
      folded: { state: paid, created: true, openedWithout: null },
      version: 3,
      persons: [],
    });
    expect(evolves.placed).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual(["mismatch"]);
    expect(await storage.snapshotStore.get(stream)).toBeNull();
    expect(entries).toEqual([
      {
        level: "error",
        message: "snapshot folds to a state that differs from the stream; dropped",
        fields: { ...stream, version: 2, head: 3 },
      },
    ]);
  });

  it("throws on a snapshot that folds to another state in strict mode", async () => {
    const { storage, snapshot, load, outcomes, entries } = await setUp({ strict: true });
    await storage.snapshotStore.put(
      snapshot({
        state: serializeFold({ state: paid, created: true, openedWithout: "OrderPlaced" }),
      }),
    );
    await expect(load()).rejects.toThrow(
      new SnapshotError(
        "Snapshot of order:1 at version 2 folds to a state at version 2 that differs from the stream's; the fold is not a function of the events alone",
      ),
    );
    expect(outcomes()).toEqual(["mismatch"]);
    expect(entries).toEqual([]);
    expect(await storage.snapshotStore.get(stream)).not.toBeNull();
  });
});
