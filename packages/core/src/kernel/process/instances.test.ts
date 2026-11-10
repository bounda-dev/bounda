import { describe, expect, it } from "vitest";
import { ForgottenSinceLoadError } from "../../adapter/storage/append-checks.ts";
import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { memory } from "../../memory/index.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { withPersonalData } from "../personal-data/event-store.ts";
import { keysOver, removeKeys } from "../test-support.ts";
import { createUnitOfWork } from "../unit-of-work/unit-of-work.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { createProcessInstances } from "./instances.ts";
import { lifecycleEntries, PROCESS_EVENTS } from "./lifecycle.ts";

const process: ProcessRuntime = {
  name: "order.settlement",
  aggregate: "order",
  startedBy: new Set(["order.OrderPlaced"]),
  completedBy: new Set(),
  lifetimeMs: 60_000,
  handlerTimeoutMs: 30_000,
  initialState: {},
  stateSchema: null,
  personal: null,
  handlers: {},
  deadlineFields: [],
  deadlineHandlers: {},
  ports: {},
  instanceOf: (event) => event.aggregateId,
};

const context = { correlationId: "c", causationId: "c", depth: 0 };

describe("createProcessInstances", () => {
  it("appends after an instance loaded through the same view, and refuses one loaded elsewhere", async () => {
    const storage = await memory().createStorage();
    const args = { ids: createSequentialIdGenerator(), clock: createFixedClock(new Date(0)) };
    const live = createProcessInstances({ eventStore: storage.eventStore, ...args });
    const unit = createUnitOfWork({ storage });
    const within = createProcessInstances({ eventStore: unit.eventStore, ...args });

    const loadedElsewhere = await live.load(process, "o-1");
    await expect(
      within.append(process, "o-1", loadedElsewhere, [lifecycleEntries.resumed(context)]),
    ).rejects.toThrow("without loading it through the same view");
    await unit.commit();
    expect((await live.load(process, "o-1")).exists).toBe(false);

    const instance = await within.load(process, "o-1");
    await within.append(process, "o-1", instance, [lifecycleEntries.resumed(context)]);
    await unit.commit();
    expect((await live.load(process, "o-1")).version).toBe(1);
    const { events } = await storage.eventStore.load({
      aggregateType: "process:order.settlement",
      aggregateId: "o-1",
    });
    expect(events.map((event) => event.type)).toEqual([PROCESS_EVENTS.resumed]);
  });

  it("keeps apart the instances of two aggregates' processes of the same name", async () => {
    const storage = await memory().createStorage();
    const instances = createProcessInstances({
      eventStore: storage.eventStore,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(new Date(0)),
    });
    const shipment: ProcessRuntime = {
      ...process,
      name: "shipment.settlement",
      aggregate: "shipment",
    };
    const order = await instances.load(process, "o-1");
    await instances.append(process, "o-1", order, [lifecycleEntries.resumed(context)]);
    expect((await instances.load(process, "o-1")).exists).toBe(true);
    expect((await instances.load(shipment, "o-1")).exists).toBe(false);
  });

  it("loads with the keys the state was opened under, and appends only while they hold", async () => {
    const storage = await memory().createStorage();
    const onboarding: ProcessRuntime = {
      ...process,
      personal: {
        person: "customerId",
        fields: ["email"],
        categories: { email: DEFAULT_PERSONAL_CATEGORY },
      },
    };
    const instances = createProcessInstances({
      eventStore: withPersonalData({
        eventStore: storage.eventStore,
        aggregates: buildAggregates({ registry: { aggregates: {}, readModels: {} }, ports: {} }),
        processes: { byName: { [onboarding.name]: onboarding } },
        keys: keysOver(storage.personalKeys),
      }),
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(new Date(0)),
    });
    const placed = pendingEvent({ aggregateId: "o-1", version: 1 });
    const state = { customerId: "c-1", email: "ana@example.com" };
    const handled = lifecycleEntries.handled({ ...placed, position: 1 }, state);

    const fresh = await instances.load(onboarding, "o-1");
    expect(fresh.persons).toEqual([]);
    await instances.append(onboarding, "o-1", fresh, [handled]);
    const loaded = await instances.load(onboarding, "o-1");
    const fingerprint =
      (await storage.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY))?.fingerprint ?? null;
    expect(loaded.state).toEqual(state);
    expect(loaded.persons).toEqual([{ person: "c-1", fingerprint }]);

    await removeKeys(storage.personalKeys, "c-1");
    await expect(
      instances.append(onboarding, "o-1", loaded, [lifecycleEntries.resumed(context)]),
    ).rejects.toThrow(ForgottenSinceLoadError);
    const forgotten = await instances.load(onboarding, "o-1");
    expect(forgotten.state).toEqual({ ...state, email: null });
    expect(forgotten.persons).toEqual([]);
  });
});
