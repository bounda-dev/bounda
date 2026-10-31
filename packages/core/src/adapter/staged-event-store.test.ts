import { describe, expect, it } from "vitest";
import { ConcurrencyError } from "../contracts/errors.ts";
import { createMemoryEventStore } from "../memory/event-store.ts";
import { createStagedEventStore } from "./staged-event-store.ts";
import { testKeyedPerson as held, pendingEvent } from "./testing/fixtures.ts";

const order = { aggregateType: "order", aggregateId: "1" };
const customer = { aggregateType: "customer", aggregateId: "1" };

const setUp = async () => {
  const base = createMemoryEventStore();
  await base.append({
    ...order,
    expectedVersion: 0,
    events: [pendingEvent({ aggregateId: "1", version: 1 })],
  });
  await base.append({
    ...customer,
    expectedVersion: 0,
    events: [
      pendingEvent({
        aggregateType: "customer",
        aggregateId: "1",
        version: 1,
        type: "CustomerRegistered",
      }),
    ],
  });
  return { base, staged: createStagedEventStore(base) };
};

describe("createStagedEventStore", () => {
  it("reports the keys the base store's load opened, and none it was not given", async () => {
    const { base } = await setUp();
    const fingerprints = new Map([["c-1", "f-1"]]);
    const opening = createStagedEventStore({
      ...base,
      load: async (args) => ({ ...(await base.load(args)), fingerprints }),
    });
    expect((await opening.load(order)).fingerprints).toBe(fingerprints);
    expect(await createStagedEventStore(base).load(order)).not.toHaveProperty("fingerprints");
  });

  it("loads one stream: the base store's events plus what was staged for it, at the version both make", async () => {
    const { staged } = await setUp();
    const before = await staged.load(order);
    expect(before.events.map((event) => [event.aggregateType, event.version])).toEqual([
      ["order", 1],
    ]);
    expect(before.version).toBe(1);

    const appended = await staged.append({
      ...order,
      expectedVersion: before.version,
      events: [pendingEvent({ aggregateId: "1", version: 2, type: "OrderPaid" })],
    });
    expect(appended).toMatchObject({ version: 2, events: [{ type: "OrderPaid", position: 0 }] });
    const after = await staged.load(order);
    expect(after.events.map((event) => [event.type, event.version])).toEqual([
      ["OrderPlaced", 1],
      ["OrderPaid", 2],
    ]);
    expect(after.version).toBe(2);
    expect((await staged.load(customer)).events.map((event) => event.type)).toEqual([
      "CustomerRegistered",
    ]);
  });

  it("loads from a version onwards, staged events included", async () => {
    const { staged } = await setUp();
    await staged.append({
      ...order,
      expectedVersion: 1,
      events: [
        pendingEvent({ aggregateId: "1", version: 2, type: "OrderPaid" }),
        pendingEvent({ aggregateId: "1", version: 3, type: "OrderArchived" }),
      ],
    });
    const loaded = await staged.load({ ...order, fromVersion: 3 });
    expect(loaded.events.map((event) => event.version)).toEqual([3]);
    expect(loaded.version).toBe(3);
  });

  it("keeps the view at the version it first met a stream at, however the base store moves", async () => {
    const { base, staged } = await setUp();
    await staged.append({
      ...order,
      expectedVersion: 1,
      events: [pendingEvent({ aggregateId: "1", version: 2, type: "OrderPaid" })],
    });
    await base.append({
      ...order,
      expectedVersion: 1,
      events: [
        pendingEvent({ aggregateId: "1", version: 2, type: "OrderCancelled", id: "theirs" }),
      ],
    });
    const loaded = await staged.load(order);
    expect(loaded.events.map((event) => event.type)).toEqual(["OrderPlaced", "OrderPaid"]);
    expect(loaded.version).toBe(2);
    expect(staged.batches()).toEqual([expect.objectContaining({ ...order, expectedVersion: 1 })]);
  });

  it("remembers a stream from its first load, so an append after the base moved still stages at that version", async () => {
    const { base, staged } = await setUp();
    const loaded = await staged.load(order);
    await base.append({
      ...order,
      expectedVersion: 1,
      events: [
        pendingEvent({ aggregateId: "1", version: 2, type: "OrderCancelled", id: "theirs" }),
      ],
    });
    await staged.append({
      ...order,
      expectedVersion: loaded.version,
      events: [pendingEvent({ aggregateId: "1", version: 2, type: "OrderPaid" })],
    });
    expect(staged.batches()).toEqual([expect.objectContaining({ ...order, expectedVersion: 1 })]);
  });

  it("rejects an append at the wrong version with the stream and both versions", async () => {
    const { staged } = await setUp();
    const stale = await staged
      .append({
        ...order,
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "1", version: 1 })],
      })
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(ConcurrencyError);
    expect(stale).toMatchObject({ streamId: "order:1", expectedVersion: 0, actualVersion: 1 });
    expect(staged.batches()).toEqual([]);
  });

  it("hands out one batch per stream written, expecting the base version, without positions", async () => {
    const { staged } = await setUp();
    await staged.load(customer);
    await staged.append({
      ...order,
      expectedVersion: 1,
      events: [pendingEvent({ aggregateId: "1", version: 2, type: "OrderPaid" })],
    });
    await staged.append({
      ...order,
      expectedVersion: 2,
      events: [pendingEvent({ aggregateId: "1", version: 3, type: "OrderArchived" })],
    });
    const fresh = { aggregateType: "payment", aggregateId: "9" };
    await staged.append({
      ...fresh,
      expectedVersion: 0,
      events: [pendingEvent({ ...fresh, version: 1, type: "PaymentRequested" })],
    });
    const batches = staged.batches();
    expect(batches.map((batch) => [batch.aggregateType, batch.expectedVersion])).toEqual([
      ["order", 1],
      ["payment", 0],
    ]);
    expect(batches[0]?.events.map((event) => event.type)).toEqual(["OrderPaid", "OrderArchived"]);
    expect(batches.flatMap((batch) => batch.events.map((event) => "position" in event))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("hands out with each batch every person its appends were decided on", async () => {
    const { staged } = await setUp();
    await staged.append({
      ...order,
      expectedVersion: 1,
      events: [pendingEvent({ aggregateId: "1", version: 2, type: "OrderPaid" })],
      persons: [held("c-1", "1"), held("c-3", null)],
    });
    await staged.append({
      ...order,
      expectedVersion: 2,
      events: [pendingEvent({ aggregateId: "1", version: 3, type: "OrderArchived" })],
      persons: [held("c-2", "2"), held("c-1", "1"), held("c-1", "again"), held("c-3", null)],
    });
    const fresh = { aggregateType: "payment", aggregateId: "9" };
    await staged.append({
      ...fresh,
      expectedVersion: 0,
      events: [pendingEvent({ ...fresh, version: 1, type: "PaymentRequested" })],
    });
    expect(staged.batches().map((batch) => batch.persons)).toEqual([
      [held("c-1", "1"), held("c-3", null), held("c-2", "2"), held("c-1", "again")],
      [],
    ]);
  });

  it("reads the global stream from the base store alone", async () => {
    const { staged } = await setUp();
    await staged.append({
      ...order,
      expectedVersion: 1,
      events: [pendingEvent({ aggregateId: "1", version: 2, type: "OrderPaid" })],
    });
    expect(await staged.lastPosition()).toBe(2);
    expect(
      (await staged.readAll({ afterPosition: 0, limit: 10 })).map((event) => event.position),
    ).toEqual([1, 2]);
  });
});
