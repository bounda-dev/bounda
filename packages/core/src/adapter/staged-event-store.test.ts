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
  it("reads a person's events from the base store alone, as it reads the global stream", async () => {
    const { base, staged } = await setUp();
    await base.append({
      ...customer,
      expectedVersion: 1,
      events: [pendingEvent({ ...customer, version: 2, type: "CustomerMoved", person: "c-1" })],
    });
    await staged.append({
      ...customer,
      expectedVersion: 2,
      events: [pendingEvent({ ...customer, version: 3, type: "CustomerMoved", person: "c-1" })],
    });
    const read = await staged.readByPerson({ person: "c-1", afterPosition: 0, limit: 10 });
    expect(read.map((event) => [event.version, event.position])).toEqual([[2, 3]]);
  });

  it("reports the keys the base store's load opened, and none it was not given", async () => {
    const { base } = await setUp();
    const opened = [{ person: "c-1", fingerprint: "f-1" }];
    const opening = createStagedEventStore({
      ...base,
      load: async (args) => ({ ...(await base.load(args)), opened }),
    });
    expect((await opening.load(order)).opened).toBe(opened);
    expect(await createStagedEventStore(base).load(order)).not.toHaveProperty("opened");
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

  it("hands out with each batch every person its appends were decided on and touch", async () => {
    const { staged } = await setUp();
    await staged.append({
      ...order,
      expectedVersion: 1,
      events: [pendingEvent({ aggregateId: "1", version: 2, type: "OrderPaid" })],
      persons: [held("c-1", "1"), held("c-3", null)],
      touches: ["c-1"],
    });
    await staged.append({
      ...order,
      expectedVersion: 2,
      events: [pendingEvent({ aggregateId: "1", version: 3, type: "OrderArchived" })],
      persons: [held("c-2", "2"), held("c-1", "1"), held("c-1", "again"), held("c-3", null)],
      touches: ["c-2", "c-1"],
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
    expect(staged.batches().map((batch) => batch.touches)).toEqual([["c-1", "c-2"], []]);
  });

  it("reads the global stream and single events from the base store alone", async () => {
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
    expect(await staged.readOne({ ...order, eventId: "order-1-1" })).toMatchObject({
      version: 1,
      position: 1,
    });
    expect(await staged.readOne({ ...order, eventId: "order-1-2" })).toBeNull();
  });

  it("carries the keys sealed under and the basis of a stream's appends to its batch, no basis once two named different ones", async () => {
    const { staged } = await setUp();
    const event = (version: number) => pendingEvent({ aggregateId: "1", version });
    await staged.append({
      ...order,
      expectedVersion: 1,
      events: [event(2)],
      seals: [held("c-1", "f-1"), held("c-1", "f-1")],
      basis: "consent",
    });
    await staged.append({ ...order, expectedVersion: 2, events: [event(3)], basis: "consent" });
    await staged.append({
      ...customer,
      expectedVersion: 1,
      events: [pendingEvent({ aggregateType: "customer", aggregateId: "1", version: 2 })],
      basis: "legal-claims",
    });
    await staged.append({
      ...customer,
      expectedVersion: 2,
      events: [pendingEvent({ aggregateType: "customer", aggregateId: "1", version: 3 })],
    });
    const [orders, customers] = staged.batches();
    expect(orders).toMatchObject({ seals: [held("c-1", "f-1")], basis: "consent" });
    expect(customers).toMatchObject({ seals: [] });
    expect(customers).not.toHaveProperty("basis");
  });

  it("names no basis for a stream whose first append named none, whatever the later ones say", async () => {
    const { staged } = await setUp();
    await staged.append({
      ...order,
      expectedVersion: 1,
      events: [pendingEvent({ aggregateId: "1", version: 2 })],
    });
    await staged.append({
      ...order,
      expectedVersion: 2,
      events: [pendingEvent({ aggregateId: "1", version: 3 })],
      basis: "consent",
    });
    expect(staged.batches()[0]).not.toHaveProperty("basis");
  });
});
