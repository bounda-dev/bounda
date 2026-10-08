import { describe, expectTypeOf, it } from "vitest";
import type { OrderCreatedState, OrderState } from "./fixtures/order-app-inferred/.bounda/types.ts";
import type { Event as OrderPaid } from "./fixtures/order-app-inferred/app/domain/order/+types/order-paid.ts";
import type { Event as OrderPlaced } from "./fixtures/order-app-inferred/app/domain/order/+types/order-placed.ts";
import type { Command as PayOrder } from "./fixtures/order-app-inferred/app/domain/order/commands/+types/pay-order.ts";
import type { Line } from "./fixtures/order-app-inferred/app/domain/order/order-placed.ts";

type HandlerState = PayOrder.HandlerArgs["state"];

describe("state inferred from begin and evolve functions", () => {
  it("unions the literal types every event assigns and requires what begin always sets", () => {
    expectTypeOf<OrderCreatedState["status"]>().toEqualTypeOf<"cancelled" | "paid" | "placed">();
    expectTypeOf<OrderCreatedState["placedAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<OrderCreatedState["paidWith"]>().toEqualTypeOf<"card" | "transfer" | undefined>();
  });

  it("references exported types of the event modules and gives up on private ones", () => {
    expectTypeOf<OrderCreatedState["lines"]>().toEqualTypeOf<readonly Line[]>();
    expectTypeOf<OrderCreatedState["cancellation"]>().toEqualTypeOf<unknown>();
  });

  it("leaves every field undefined before the aggregate is created", () => {
    expectTypeOf<OrderState["status"]>().toEqualTypeOf<
      "cancelled" | "paid" | "placed" | undefined
    >();
    expectTypeOf<OrderState["customerId"]>().toEqualTypeOf<string | undefined>();
  });

  it("narrows a handler's state by a field begin always sets", () => {
    const state = {} as HandlerState;
    if (state.status === undefined) {
      expectTypeOf(state.customerId).toEqualTypeOf<undefined>();
    } else {
      expectTypeOf(state.customerId).toEqualTypeOf<string>();
      expectTypeOf(state.lines).toEqualTypeOf<readonly Line[]>();
    }
    if (state.status === "placed") expectTypeOf(state.placedAt).toEqualTypeOf<Date>();
    if (state.customerId !== undefined) expectTypeOf(state.placedAt).toEqualTypeOf<Date>();
    expectTypeOf(state.version).toEqualTypeOf<number>();
    expectTypeOf(state.id).toEqualTypeOf<string>();
  });

  it("does not narrow by version, which the runtime adds to any state", () => {
    const state = {} as HandlerState;
    if (state.version === 0) expectTypeOf(state.customerId).toEqualTypeOf<string | undefined>();
  });

  it("gives evolve the created state and begin the event alone", () => {
    expectTypeOf<OrderPaid.EvolveArgs["state"]["customerId"]>().toEqualTypeOf<string>();
    expectTypeOf<OrderPaid.EvolveArgs["event"]["payload"]["method"]>().toEqualTypeOf<
      "card" | "transfer"
    >();
    expectTypeOf<keyof OrderPlaced.BeginArgs>().toEqualTypeOf<"event">();
    expectTypeOf<OrderPlaced.BeginArgs["event"]["payload"]["customerId"]>().toEqualTypeOf<string>();
  });
});
