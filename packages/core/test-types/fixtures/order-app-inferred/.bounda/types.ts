import type * as core from "@bounda-dev/core";

export type OrderState = {
  readonly cancellation?: unknown;
  readonly customerId?: string;
  readonly lines?: readonly import("../app/domain/order/order-placed.ts").Line[];
  readonly paidWith?: "card" | "transfer";
  readonly placedAt?: Date;
  readonly status?: "cancelled" | "paid" | "placed";
};
export type OrderEvents = {
  readonly orderCancelled: typeof import("../app/domain/order/order-cancelled.ts");
  readonly orderPaid: typeof import("../app/domain/order/order-paid.ts");
  readonly orderPlaced: typeof import("../app/domain/order/order-placed.ts");
};

export type Commands = core.CommandsFacadeOf<{
  readonly payOrder: typeof import("../app/domain/order/commands/pay-order.ts");
  readonly placeOrder: typeof import("../app/domain/order/commands/place-order.ts");
}>;

export type Queries = core.QueriesFacadeOf<Record<never, never>>;
