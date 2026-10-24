import { describe, expect, it } from "vitest";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { resolveConfig } from "../../config/schema.ts";
import { memory } from "../../memory/index.ts";
import { choosePorts, orderRegistry } from "../test-support.ts";
import { buildAggregates } from "./build-aggregates.ts";
import { foldState } from "./fold-state.ts";

const ports = choosePorts(
  orderRegistry,
  resolveConfig({ storage: memory(), ports: { order: { notifier: "silent" } } }),
);
const aggregate = buildAggregates({ registry: orderRegistry, ports }).byName.order;
if (aggregate === undefined) throw new Error("no order aggregate");

const stored = (version: number, type: string, payload: unknown) => ({
  ...pendingEvent({ aggregateId: "1", version, type, payload }),
  position: version,
});

describe("foldState from a snapshot", () => {
  it("folds the events after it over its state, keeping how the aggregate opened", () => {
    const from = {
      state: { status: "placed", total: 5, extra: "kept" },
      created: true,
      openedWithout: "OrderPlaced",
    };
    const folded = foldState({
      aggregate,
      events: [stored(3, "OrderPaid", { method: "card" })],
      from,
    });
    expect(folded).toEqual({
      state: { status: "paid", total: 5, extra: "kept" },
      created: true,
      openedWithout: "OrderPlaced",
    });
    expect(from.state).toEqual({ status: "placed", total: 5, extra: "kept" });
  });

  it("is the snapshot itself when nothing came after it", () => {
    const from = { state: { status: "placed", total: 5 }, created: true, openedWithout: null };
    expect(foldState({ aggregate, events: [], from })).toEqual(from);
  });
});
