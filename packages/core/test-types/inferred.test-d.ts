import { describe, expectTypeOf, it } from "vitest";
import type { OrderState } from "./fixtures/order-app-inferred/.bounda/types.ts";
import type { Event as OrderPaid } from "./fixtures/order-app-inferred/app/domain/order/+types/order-paid.ts";
import type { Command as PayOrder } from "./fixtures/order-app-inferred/app/domain/order/commands/+types/pay-order.ts";
import type { Line } from "./fixtures/order-app-inferred/app/domain/order/order-placed.ts";

describe("state inferred from apply functions", () => {
  it("unions the literal types every apply assigns and makes every field optional", () => {
    expectTypeOf<OrderState["status"]>().toEqualTypeOf<
      "cancelled" | "paid" | "placed" | undefined
    >();
    expectTypeOf<OrderState["paidWith"]>().toEqualTypeOf<"card" | "transfer" | undefined>();
    expectTypeOf<OrderState["placedAt"]>().toEqualTypeOf<Date | undefined>();
  });

  it("references exported types of the event modules and gives up on private ones", () => {
    expectTypeOf<OrderState["lines"]>().toEqualTypeOf<readonly Line[] | undefined>();
    expectTypeOf<OrderState["cancellation"]>().toEqualTypeOf<unknown>();
  });

  it("reaches handlers and apply through the generated +types", () => {
    expectTypeOf<PayOrder.HandlerArgs["state"]["status"]>().toEqualTypeOf<
      "cancelled" | "paid" | "placed" | undefined
    >();
    expectTypeOf<PayOrder.HandlerArgs["state"]["version"]>().toEqualTypeOf<number>();
    expectTypeOf<OrderPaid.ApplyArgs["state"]["customerId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<OrderPaid.ApplyArgs["event"]["payload"]["method"]>().toEqualTypeOf<
      "card" | "transfer"
    >();
  });
});
