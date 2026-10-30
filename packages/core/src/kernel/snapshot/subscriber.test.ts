import { describe, expect, it, vi } from "vitest";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { resolveConfig } from "../../config/schema.ts";
import { SnapshotError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { createAggregateLoader } from "../aggregate/load-aggregate.ts";
import { deserializeFold, serializeFold } from "../aggregate/snapshot-codec.ts";
import { choosePorts, createRecordingLogger, orderAggregate } from "../test-support.ts";
import { createSnapshotSubscriber, takesSnapshots } from "./subscriber.ts";

class Clock {}

const registry: Registry = {
  aggregates: {
    order: { ...orderAggregate, stateFingerprint: "fp" },
    ticker: {
      stateFingerprint: "tick",
      events: { ticked: { evolve: () => ({ clock: new Clock() }) } },
      commands: {},
      policies: {},
      processes: {},
    },
  },
  readModels: {},
};

interface SetUpArgs {
  readonly aggregate?: "order" | "ticker";
  readonly strict?: boolean;
}

const setUp = async ({ aggregate: name = "order", strict = false }: SetUpArgs = {}) => {
  const adapter = memory();
  const config = resolveConfig({
    storage: adapter,
    ports: { order: { notifier: "silent" } },
    runtime: {
      overrides: { order: { snapshot: { every: 2 } }, ticker: { snapshot: { every: 1 } } },
    },
  });
  const aggregate = buildAggregates({ registry, ports: choosePorts(registry, config), config })
    .byName[name];
  if (aggregate === undefined || !takesSnapshots(aggregate)) throw new Error("no aggregate");
  const storage = await adapter.createStorage({ logger: createRecordingLogger().logger });
  const { logger, entries } = createRecordingLogger();
  const errors: SnapshotError[] = [];
  const snapshotStore = {
    ...storage.snapshotStore,
    get: vi.fn(storage.snapshotStore.get),
    put: vi.fn(storage.snapshotStore.put),
  };
  const subscriber = createSnapshotSubscriber({
    aggregate,
    eventStore: storage.eventStore,
    snapshotStore,
    loader: createAggregateLoader({ snapshotStore, logger, strict }),
    logger,
    ...(strict ? { strict: { onError: (error: SnapshotError) => errors.push(error) } } : {}),
  });
  const append = async (
    aggregateType: string,
    aggregateId: string,
    ...events: readonly (readonly [number, string, unknown])[]
  ) => {
    await storage.eventStore.append({
      aggregateType,
      aggregateId,
      expectedVersion: (events[0]?.[0] ?? 1) - 1,
      events: events.map(([version, type, payload]) =>
        pendingEvent({ aggregateType, aggregateId, version, type, payload }),
      ),
    });
  };
  const deliver = async (afterPosition = 0) =>
    subscriber.process(await storage.eventStore.readAll({ afterPosition, limit: 100 }));
  const stored = async (aggregateId = "1") =>
    storage.snapshotStore.get({ aggregateType: name, aggregateId });
  return { subscriber, storage, snapshotStore, entries, errors, append, deliver, stored };
};

describe("createSnapshotSubscriber", () => {
  it("writes a snapshot of a stream that gathered `every` events, at the head it finds", async () => {
    const { subscriber, snapshotStore, append, deliver, stored, entries } = await setUp();
    expect(subscriber).toMatchObject({ name: "snapshot:order", kind: "snapshot" });
    await append("order", "1", [1, "OrderPlaced", { total: 10 }]);
    expect(await deliver()).toBe(1);
    expect(await stored()).toBeNull();
    expect(snapshotStore.get).not.toHaveBeenCalled();
    await append("order", "1", [2, "OrderPaid", { method: "card" }]);
    await append("order", "1", [3, "OrderArchived", {}]);
    expect(await deliver(1)).toBe(2);
    const snapshot = await stored();
    expect(snapshot).toMatchObject({
      aggregateType: "order",
      aggregateId: "1",
      version: 3,
      fingerprint: "fp:1",
    });
    expect(deserializeFold(snapshot?.state ?? "")).toEqual({
      state: { status: "paid", total: 10 },
      created: true,
      openedWithout: null,
    });
    expect(entries).toEqual([
      {
        level: "debug",
        message: "snapshot written",
        fields: { aggregateType: "order", aggregateId: "1", version: 3 },
      },
    ]);
  });

  it("counts the events since the last snapshot of this code, per stream", async () => {
    const { snapshotStore, storage, append, deliver, stored } = await setUp();
    await append(
      "order",
      "1",
      [1, "OrderPlaced", { total: 10 }],
      [2, "OrderPaid", { method: "card" }],
    );
    await append("order", "2", [1, "OrderPlaced", { total: 7 }]);
    await append("customer", "9", [1, "CustomerRegistered", {}], [2, "CustomerRegistered", {}]);
    expect(await deliver()).toBe(5);
    expect(snapshotStore.put).toHaveBeenCalledTimes(1);
    expect(await stored("1")).toMatchObject({ version: 2 });
    expect(await stored("2")).toBeNull();
    expect(await stored("9")).toBeNull();
    await append("order", "1", [3, "OrderArchived", {}]);
    await deliver(5);
    expect(await stored("1")).toMatchObject({ version: 2 });
    await append("order", "1", [4, "OrderArchived", {}]);
    await deliver(6);
    expect(await stored("1")).toMatchObject({ version: 4 });
    await storage.snapshotStore.put({
      aggregateType: "order",
      aggregateId: "1",
      version: 4,
      fingerprint: "fp:2",
      state: serializeFold({ state: {}, created: true, openedWithout: null }),
    });
    await append("order", "1", [5, "OrderArchived", {}]);
    await deliver(7);
    expect(await stored("1")).toMatchObject({ version: 5, fingerprint: "fp:1" });
  });

  it("logs a state it cannot keep and goes on", async () => {
    const { append, deliver, stored, entries } = await setUp({ aggregate: "ticker" });
    await append("ticker", "1", [1, "Ticked", {}]);
    expect(await deliver()).toBe(1);
    expect(await stored()).toBeNull();
    expect(entries).toEqual([
      {
        level: "error",
        message: "aggregate state cannot be snapshotted",
        fields: expect.objectContaining({
          aggregateType: "ticker",
          aggregateId: "1",
          version: 1,
          message: "Cannot stringify arbitrary non-POJOs",
        }),
      },
    ]);
  });

  it("throws on a state it cannot keep in strict mode, telling the app first", async () => {
    const { append, deliver, stored, entries, errors } = await setUp({
      aggregate: "ticker",
      strict: true,
    });
    await append("ticker", "1", [1, "Ticked", {}]);
    const error = await deliver().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as SnapshotError).message).toBe(
      "State of ticker:1 cannot be snapshotted: Cannot stringify arbitrary non-POJOs",
    );
    expect(errors).toEqual([error]);
    expect((error as SnapshotError).cause).toMatchObject({ name: "DevalueError" });
    expect(await stored()).toBeNull();
    expect(entries).toEqual([]);
  });

  it("lets any other failure of the batch through, telling the app nothing", async () => {
    for (const strict of [true, false]) {
      const { snapshotStore, append, deliver, errors } = await setUp({ strict });
      snapshotStore.get.mockRejectedValue(new Error("database down"));
      await append(
        "order",
        "1",
        [1, "OrderPlaced", { total: 10 }],
        [2, "OrderPaid", { method: "card" }],
      );
      await expect(deliver()).rejects.toThrow("database down");
      expect(errors).toEqual([]);
    }
  });

  it("tells the app of a snapshot that folds to another state in strict mode", async () => {
    const { storage, append, deliver, errors } = await setUp({ strict: true });
    await append(
      "order",
      "1",
      [1, "OrderPlaced", { total: 10 }],
      [2, "OrderPaid", { method: "card" }],
    );
    await storage.snapshotStore.put({
      aggregateType: "order",
      aggregateId: "1",
      version: 2,
      fingerprint: "fp:1",
      state: serializeFold({
        state: { status: "paid", total: 99 },
        created: true,
        openedWithout: null,
      }),
    });
    await append("order", "1", [3, "OrderArchived", {}], [4, "OrderArchived", {}]);
    await expect(deliver(2)).rejects.toThrow(SnapshotError);
    expect(errors).toHaveLength(1);
  });
});
