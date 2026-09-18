import { describe, expect, it } from "vitest";
import { createEventBuilders } from "./event.ts";
import type { PayloadArgs } from "./payload.ts";

const orderPlaced = {
  payload: ({ z }: PayloadArgs) => z.object({ total: z.number() }),
  apply: () => ({}),
};
const orderCancelled = { apply: () => ({}) };

describe("createEventBuilders", () => {
  const events = createEventBuilders({ orderPlaced, orderCancelled });

  it("creates one builder per event, keyed like the registry", () => {
    expect(Object.keys(events)).toEqual(["orderPlaced", "orderCancelled"]);
  });

  it("derives the PascalCase type name and carries the payload", () => {
    expect(events.orderPlaced({ total: 42 })).toEqual({
      type: "OrderPlaced",
      payload: { total: 42 },
    });
  });

  it("gives payload-less events an empty payload", () => {
    expect(events.orderCancelled()).toEqual({ type: "OrderCancelled", payload: {} });
  });
});
