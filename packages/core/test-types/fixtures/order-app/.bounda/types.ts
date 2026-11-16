import type * as core from "@bounda-dev/core";

export type CustomerState = core.StateOf<typeof import("../app/domain/customer/state.ts")>;
export type CustomerCreatedState = CustomerState;
export type CustomerEvents = {
  readonly customerRegistered: typeof import("../app/domain/customer/customer-registered.ts");
};
export type CustomerPorts = core.EmptyPayload;
export type CustomerClassification = [
  Expect<core.ClassifiesPayload<"customer.CustomerRegistered", typeof import("../app/domain/customer/customer-registered.ts")>>,
  Expect<core.ClassifiesPayload<"customer.registerCustomer", typeof import("../app/domain/customer/commands/register-customer.ts")>>,
];

export type OrderState = core.StateOf<typeof import("../app/domain/order/state.ts")>;
export type OrderCreatedState = OrderState;
export type OrderEvents = {
  readonly orderCancelled: typeof import("../app/domain/order/order-cancelled.ts");
  readonly orderPaid: typeof import("../app/domain/order/order-paid.ts");
  readonly orderPlaced: typeof import("../app/domain/order/order-placed.ts");
};
export type OrderPorts = {
  readonly auditLog: import("../app/domain/order/audit-log.ts").AuditLog;
  readonly inventory: import("../app/domain/order/inventory.ts").Inventory;
  readonly mailer: import("../app/domain/order/mailer.ts").Mailer;
  readonly reminders: import("../app/domain/order/reminders.ts").Reminders;
};
export type OrderClassification = [
  Expect<core.ClassifiesPayload<"order.OrderCancelled", typeof import("../app/domain/order/order-cancelled.ts")>>,
  Expect<core.ClassifiesPayload<"order.OrderPaid", typeof import("../app/domain/order/order-paid.ts")>>,
  Expect<core.ClassifiesPayload<"order.OrderPlaced", typeof import("../app/domain/order/order-placed.ts")>>,
  Expect<core.ClassifiesPayload<"order.cancelOrder", typeof import("../app/domain/order/commands/cancel-order.ts")>>,
  Expect<core.ClassifiesPayload<"order.payOrder", typeof import("../app/domain/order/commands/pay-order.ts")>>,
  Expect<core.ClassifiesPayload<"order.placeOrder", typeof import("../app/domain/order/commands/place-order.ts")>>,
  Expect<core.ClassifiesState<"order.orderPayment", typeof import("../app/domain/order/processes/order-payment/index.ts")>>,
];
export type OrderRecipients = [
  Expect<core.NotifiesRecipient<"order.mailer", typeof import("../app/domain/order/mailer.ts"), import("../app/domain/order/mailer.ts").Mailer>>,
];

export type Events = {
  readonly customer: CustomerEvents;
  readonly order: OrderEvents;
};

export type PortsConfig = {
  readonly order: {
    readonly auditLog?: "memory";
    readonly inventory: "fake" | "http" | "memory";
    readonly mailer?: "memory";
    readonly reminders?: "fake";
  };
  readonly orderSummary?: {
    readonly rates?: "fixed";
  };
};

export type TestPorts = {
  readonly order?: {
    readonly auditLog?: "memory" | OrderPorts["auditLog"];
    readonly inventory?: "fake" | "http" | "memory" | OrderPorts["inventory"];
    readonly mailer?: "memory" | OrderPorts["mailer"];
    readonly reminders?: "fake" | OrderPorts["reminders"];
  };
  readonly orderSummary?: {
    readonly rates?: "fixed" | OrderSummaryPorts["rates"];
  };
};

export type Commands = core.CommandsFacadeOf<{
  readonly registerCustomer: typeof import("../app/domain/customer/commands/register-customer.ts");
  readonly cancelOrder: typeof import("../app/domain/order/commands/cancel-order.ts");
  readonly payOrder: typeof import("../app/domain/order/commands/pay-order.ts");
  readonly placeOrder: typeof import("../app/domain/order/commands/place-order.ts");
}>;

export type ReactionCommands = core.ReactionCommandsFacadeOf<{
  readonly registerCustomer: typeof import("../app/domain/customer/commands/register-customer.ts");
  readonly cancelOrder: typeof import("../app/domain/order/commands/cancel-order.ts");
  readonly payOrder: typeof import("../app/domain/order/commands/pay-order.ts");
  readonly placeOrder: typeof import("../app/domain/order/commands/place-order.ts");
}>;

type Expect<Check extends true> = Check;

export type PersonalCategory = core.PersonalCategoriesOf<typeof import("../app/personal-data.ts")>;
export type PersonalDataDeclaration = Expect<core.DeclaresPersonalData<typeof import("../app/personal-data.ts")>>;

export type CustomerDirectoryRow = core.RowOf<typeof import("../app/read/customer-directory/view.ts")>;
export type CustomerDirectoryFieldTypes = core.FieldTypesOf<typeof import("../app/read/customer-directory/view.ts")>;
export type CustomerDirectoryPorts = core.EmptyPayload;
export type CustomerDirectoryForgetting = Expect<
  core.ForgetsPersonalData<
    "customerDirectory",
    typeof import("../app/domain/customer/customer-registered.ts"),
    true,
    typeof import("../app/read/customer-directory/view.ts")
  >
>;
export type CustomerDirectoryClassification = Expect<core.ClassifiesColumns<"customerDirectory", typeof import("../app/read/customer-directory/view.ts")>>;

export type OrderSummaryRow = core.RowOf<typeof import("../app/read/order-summary/view.ts")>;
export type OrderSummaryFieldTypes = core.FieldTypesOf<typeof import("../app/read/order-summary/view.ts")>;
export type OrderSummaryPorts = {
  readonly rates: import("../app/read/order-summary/rates.ts").Rates;
};
export type OrderSummaryForgetting = Expect<
  core.ForgetsPersonalData<
    "orderSummary",
    | typeof import("../app/domain/order/order-paid.ts")
    | typeof import("../app/domain/order/order-placed.ts"),
    true,
    typeof import("../app/read/order-summary/view.ts")
  >
>;
export type OrderSummaryClassification = Expect<core.ClassifiesColumns<"orderSummary", typeof import("../app/read/order-summary/view.ts")>>;

export type Queries = core.QueriesFacadeOf<{
  readonly getCustomer: typeof import("../app/read/customer-directory/queries/get-customer.ts");
  readonly customerOverview: typeof import("../app/read/order-summary/queries/customer-overview.ts");
  readonly getOrder: typeof import("../app/read/order-summary/queries/get-order.ts");
  readonly listUnpaidOrders: typeof import("../app/read/order-summary/queries/list-unpaid-orders.ts");
}>;
