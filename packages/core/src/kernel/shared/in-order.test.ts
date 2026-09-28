import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../contracts/event.ts";
import { deliverInOrder, type ReactionOutcome } from "./in-order.ts";

const event = (position: number, type: string): StoredEvent => ({
  id: `e-${position}`,
  position,
  aggregateType: "order",
  aggregateId: "o-1",
  version: position,
  type,
  payload: {},
  timestamp: "2026-01-01T00:00:00.000Z",
  metadata: { correlationId: "c", causationId: "c", depth: 0, schemaVersion: 1, system: false },
});

const a = { name: "a" };
const b = { name: "b" };

interface Run {
  readonly byEvent: Readonly<Record<string, readonly { readonly name: string }[]>>;
  readonly holds: ReadonlySet<string>;
}

const run = async ({ byEvent, holds }: Run, events: readonly StoredEvent[]) => {
  const delivered: string[] = [];
  const done = await deliverInOrder({
    events,
    byEvent,
    deliver: async (reaction, delivering): Promise<ReactionOutcome> => {
      const key = `${reaction.name}@${delivering.position}`;
      delivered.push(key);
      return holds.has(key) ? "hold" : "done";
    },
  });
  return { done, delivered };
};

describe("deliverInOrder", () => {
  it("delivers every event to each reaction it routes to and reports the whole batch done", async () => {
    const outcome = await run(
      { byEvent: { "order.OrderPlaced": [a, b], "order.OrderPaid": [b] }, holds: new Set() },
      [event(1, "OrderPlaced"), event(2, "OrderPaid"), event(3, "OrderShipped")],
    );
    expect(outcome).toEqual({ done: 3, delivered: ["a@1", "b@1", "b@2"] });
  });

  it("skips a held reaction's later events while the others carry on", async () => {
    const outcome = await run(
      { byEvent: { "order.OrderPlaced": [a, b] }, holds: new Set(["a@2"]) },
      [event(1, "OrderPlaced"), event(2, "OrderPlaced"), event(3, "OrderPlaced")],
    );
    expect(outcome).toEqual({ done: 1, delivered: ["a@1", "b@1", "a@2", "b@2", "b@3"] });
  });

  it("reports the events before the first one held, however many reactions hold later", async () => {
    const outcome = await run(
      { byEvent: { "order.OrderPlaced": [a, b] }, holds: new Set(["b@2", "a@3"]) },
      [event(1, "OrderPlaced"), event(2, "OrderPlaced"), event(3, "OrderPlaced")],
    );
    expect(outcome).toEqual({ done: 1, delivered: ["a@1", "b@1", "a@2", "b@2", "a@3"] });
  });

  it("reports nothing done when the first event is held", async () => {
    const outcome = await run({ byEvent: { "order.OrderPlaced": [a] }, holds: new Set(["a@1"]) }, [
      event(1, "OrderPlaced"),
      event(2, "OrderPlaced"),
    ]);
    expect(outcome).toEqual({ done: 0, delivered: ["a@1"] });
  });
});
