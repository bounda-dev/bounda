import type * as core from "@bounda-dev/core";

export type CustomerState = core.StateOf<typeof import("../app/domain/customer/state.ts")>;
export type CustomerEvents = {
  readonly customerRegistered: typeof import("../app/domain/customer/customer-registered.ts");
};

export type OrderState = core.StateOf<typeof import("../app/domain/order/state.ts")>;
export type OrderEvents = {
  readonly orderCancelled: typeof import("../app/domain/order/order-cancelled.ts");
  readonly orderPaid: typeof import("../app/domain/order/order-paid.ts");
  readonly orderPlaced: typeof import("../app/domain/order/order-placed.ts");
};

export type CancelOrderCollaborators = core.InferCollaborators<{
  readonly auditLog: {
    readonly memory: typeof import("../app/domain/order/commands/cancel-order/audit-log.memory.ts").default;
  };
}>;

export type Commands = core.CommandsFacadeOf<{
  readonly registerCustomer: typeof import("../app/domain/customer/commands/register-customer.ts");
  readonly cancelOrder: typeof import("../app/domain/order/commands/cancel-order/index.ts");
  readonly payOrder: typeof import("../app/domain/order/commands/pay-order.ts");
  readonly placeOrder: typeof import("../app/domain/order/commands/place-order/index.ts");
}>;

export type OrderSummaryRow = core.RowOf<typeof import("../app/read/order-summary/view.ts")>;

export type Queries = core.QueriesFacadeOf<{
  readonly customerOverview: typeof import("../app/read/order-summary/queries/customer-overview.ts");
  readonly getOrder: typeof import("../app/read/order-summary/queries/get-order.ts");
  readonly listUnpaidOrders: typeof import("../app/read/order-summary/queries/list-unpaid-orders.ts");
}>;
