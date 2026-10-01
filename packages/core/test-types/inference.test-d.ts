import type {
  AppRegistry,
  BoundaApp,
  CatchUpReadModelsArgs,
  CommandsFacade,
  DispatchOptions,
  DispatchResult,
  DurationInput,
  Instant,
  QueriesFacade,
  ReactionDispatchResult,
  StoredEvent,
  Table,
} from "@bounda-dev/core";
import { describe, expectTypeOf, it } from "vitest";
import type { registry } from "./fixtures/order-app/.bounda/registry.ts";
import type { Commands, Queries } from "./fixtures/order-app/.bounda/types.ts";
import type { Event as CustomerRegistered } from "./fixtures/order-app/app/domain/customer/+types/customer-registered.ts";
import type { Command as RegisterCustomer } from "./fixtures/order-app/app/domain/customer/commands/+types/register-customer.ts";
import type { Event as OrderPlaced } from "./fixtures/order-app/app/domain/order/+types/order-placed.ts";
import type { Command as CancelOrder } from "./fixtures/order-app/app/domain/order/commands/+types/cancel-order.ts";
import type { Command as PayOrder } from "./fixtures/order-app/app/domain/order/commands/+types/pay-order.ts";
import type { Command as PlaceOrder } from "./fixtures/order-app/app/domain/order/commands/+types/place-order.ts";
import type { Implementation as InventoryFake } from "./fixtures/order-app/app/domain/order/inventory/+types/fake.ts";
import type { Policy as NotifyOnOrderPlaced } from "./fixtures/order-app/app/domain/order/policies/+types/notify-on-order-placed.ts";
import type { Policy as SendReceipt } from "./fixtures/order-app/app/domain/order/policies/+types/send-receipt-on-order-paid.ts";
import type { Policy as GreetOnCustomerRegistered } from "./fixtures/order-app/app/domain/order/policies/customer/+types/greet-on-customer-registered.ts";
import type { Process as AtNextReminder } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/at-next-reminder.ts";
import type { Process as AtTimeout } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/at-timeout.ts";
import type { Process as OrderPayment } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/index.ts";
import type { Process as OnOrderPaid } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/on-order-paid.ts";
import type { Process as OnCustomerRegistered } from "./fixtures/order-app/app/domain/order/processes/order-payment/customer/+types/on-customer-registered.ts";
import type { Implementation as RemindersFake } from "./fixtures/order-app/app/domain/order/reminders/+types/fake.ts";
import type { Projection as ProjectOrderPaid } from "./fixtures/order-app/app/read/order-summary/projections/order/+types/order-paid.ts";
import type { Query as CustomerOverview } from "./fixtures/order-app/app/read/order-summary/queries/+types/customer-overview.ts";
import type { Query as GetOrder } from "./fixtures/order-app/app/read/order-summary/queries/+types/get-order.ts";
import type { Query as ListUnpaidOrders } from "./fixtures/order-app/app/read/order-summary/queries/+types/list-unpaid-orders.ts";

type Registry = typeof registry;
type OrderStatus = "new" | "placed" | "paid" | "cancelled";

interface OrderSummaryRow {
  readonly orderId: string;
  readonly customerId: string;
  readonly status: string;
  readonly total: number;
  readonly paidAt?: Date;
}

describe("payload inference", () => {
  it("keeps enums and nested arrays exact", () => {
    expectTypeOf<PayOrder.HandlerArgs["command"]["payload"]["method"]>().toEqualTypeOf<
      "card" | "transfer"
    >();
    expectTypeOf<PlaceOrder.HandlerArgs["command"]["payload"]["lines"][number]>().toEqualTypeOf<{
      sku: string;
      quantity: number;
      unitPrice: number;
    }>();
  });

  it("types the command itself", () => {
    expectTypeOf<PlaceOrder.HandlerArgs["command"]["type"]>().toEqualTypeOf<"PlaceOrder">();
    expectTypeOf<PlaceOrder.HandlerArgs["command"]["aggregateId"]>().toEqualTypeOf<string>();
  });
});

describe("state inference", () => {
  it("comes from state.ts with its declared unions plus identity and version", () => {
    expectTypeOf<PlaceOrder.HandlerArgs["state"]["status"]>().toEqualTypeOf<OrderStatus>();
    expectTypeOf<PlaceOrder.HandlerArgs["state"]["total"]>().toEqualTypeOf<number>();
    expectTypeOf<PlaceOrder.HandlerArgs["state"]["id"]>().toEqualTypeOf<string>();
    expectTypeOf<PlaceOrder.HandlerArgs["state"]["version"]>().toEqualTypeOf<number>();
  });

  it("reaches apply as well", () => {
    expectTypeOf<OrderPlaced.ApplyArgs["state"]["status"]>().toEqualTypeOf<OrderStatus>();
    expectTypeOf<OrderPlaced.ApplyArgs["event"]["payload"]["customerId"]>().toEqualTypeOf<string>();
    expectTypeOf<OrderPlaced.ApplyArgs["event"]["type"]>().toEqualTypeOf<"OrderPlaced">();
    expectTypeOf<CustomerRegistered.ApplyArgs["state"]["active"]>().toEqualTypeOf<boolean>();
  });
});

describe("event builders", () => {
  it("offer only the events of the handler's own aggregate", () => {
    expectTypeOf<keyof PlaceOrder.HandlerArgs["events"]>().toEqualTypeOf<
      "orderPlaced" | "orderPaid" | "orderCancelled"
    >();
    expectTypeOf<PlaceOrder.HandlerArgs["events"]>().not.toHaveProperty("customerRegistered");
  });

  it("take the payload when the event has one and nothing otherwise", () => {
    expectTypeOf<PlaceOrder.HandlerArgs["events"]["orderPaid"]>().parameter(0).toEqualTypeOf<{
      method: "card" | "transfer";
      reference: string;
    }>();
    expectTypeOf<PlaceOrder.HandlerArgs["events"]["orderCancelled"]>().parameters.toEqualTypeOf<
      []
    >();
    expectTypeOf<
      ReturnType<PlaceOrder.HandlerArgs["events"]["orderCancelled"]>["type"]
    >().toEqualTypeOf<"OrderCancelled">();
  });
});

describe("collaborators", () => {
  type Inventory = import("./fixtures/order-app/app/domain/order/inventory/index.ts").Inventory;
  type Reminders = import("./fixtures/order-app/app/domain/order/reminders/index.ts").Reminders;

  it("are typed by the interface each port's index.ts exports", () => {
    expectTypeOf<PlaceOrder.HandlerArgs["inventory"]>().toEqualTypeOf<Inventory>();
    expectTypeOf<PlaceOrder.HandlerArgs["inventory"]["reserve"]>().toEqualTypeOf<
      (skus: readonly string[]) => Promise<void>
    >();
    expectTypeOf<CancelOrder.HandlerArgs["auditLog"]["record"]>().toEqualTypeOf<
      (entry: string) => void
    >();
  });

  it("reach every handler of the aggregate: its commands, policies and processes", () => {
    expectTypeOf<PayOrder.HandlerArgs["inventory"]>().toEqualTypeOf<Inventory>();
    expectTypeOf<PayOrder.HandlerArgs["mailer"]["send"]>().toEqualTypeOf<
      (to: string, message: string) => Promise<void>
    >();
    expectTypeOf<NotifyOnOrderPlaced.HandlerArgs["mailer"]["send"]>().toEqualTypeOf<
      (to: string, message: string) => Promise<void>
    >();
    expectTypeOf<NotifyOnOrderPlaced.HandlerArgs["event"]["type"]>().toEqualTypeOf<"OrderPlaced">();
    expectTypeOf<SendReceipt.HandlerArgs["mailer"]>().toHaveProperty("send");
    expectTypeOf<GreetOnCustomerRegistered.HandlerArgs["auditLog"]>().toHaveProperty("record");
    expectTypeOf<OnOrderPaid.HandlerArgs["inventory"]>().toEqualTypeOf<Inventory>();
    expectTypeOf<OnCustomerRegistered.HandlerArgs["inventory"]>().toEqualTypeOf<Inventory>();
    expectTypeOf<AtTimeout.DeadlineArgs["inventory"]>().toEqualTypeOf<Inventory>();
    expectTypeOf<AtNextReminder.DeadlineArgs["inventory"]>().toEqualTypeOf<Inventory>();
  });

  it("stay within their aggregate", () => {
    expectTypeOf<RegisterCustomer.HandlerArgs>().not.toHaveProperty("inventory");
    expectTypeOf<RegisterCustomer.HandlerArgs>().not.toHaveProperty("mailer");
  });

  it("may be a callable interface", () => {
    expectTypeOf<AtTimeout.DeadlineArgs["reminders"]>().toEqualTypeOf<Reminders>();
    expectTypeOf<OnOrderPaid.HandlerArgs["reminders"]>().toEqualTypeOf<
      (orderId: string) => Promise<void>
    >();
  });

  it("give each implementation its port's interface as Implementation.Contract", () => {
    expectTypeOf<InventoryFake.Contract>().toEqualTypeOf<Inventory>();
    expectTypeOf<RemindersFake.Contract>().toEqualTypeOf<Reminders>();
  });
});

describe("idempotency keys", () => {
  it("reach every handler that can call the outside world", () => {
    expectTypeOf<PlaceOrder.HandlerArgs["idempotencyKey"]>().toEqualTypeOf<string>();
    expectTypeOf<PayOrder.HandlerArgs["idempotencyKey"]>().toEqualTypeOf<string>();
    expectTypeOf<SendReceipt.HandlerArgs["idempotencyKey"]>().toEqualTypeOf<string>();
    expectTypeOf<NotifyOnOrderPlaced.HandlerArgs["idempotencyKey"]>().toEqualTypeOf<string>();
    expectTypeOf<OnOrderPaid.HandlerArgs["idempotencyKey"]>().toEqualTypeOf<string>();
    expectTypeOf<AtTimeout.DeadlineArgs["idempotencyKey"]>().toEqualTypeOf<string>();
    expectTypeOf<AtNextReminder.DeadlineArgs["idempotencyKey"]>().toEqualTypeOf<string>();
    expectTypeOf<SendReceipt.HandlerArgs["signal"]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<NotifyOnOrderPlaced.HandlerArgs["signal"]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<OnOrderPaid.HandlerArgs["signal"]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<AtTimeout.DeadlineArgs["signal"]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<AtNextReminder.DeadlineArgs["signal"]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<PlaceOrder.HandlerArgs>().not.toHaveProperty("signal");
  });
});

describe("policies", () => {
  it("receive the stored event of the file name and the full commands facade", () => {
    expectTypeOf<SendReceipt.HandlerArgs["event"]>().toEqualTypeOf<
      StoredEvent<"OrderPaid", { method: "card" | "transfer"; reference: string }>
    >();
    expectTypeOf<SendReceipt.HandlerArgs["commands"]>().toHaveProperty("payOrder");
    expectTypeOf<SendReceipt.HandlerArgs["commands"]>().toHaveProperty("registerCustomer");
  });

  it("get each command's decision, typed like app.commands but without a position", () => {
    expectTypeOf<SendReceipt.HandlerArgs["commands"]["payOrder"]>().returns.toEqualTypeOf<
      Promise<ReactionDispatchResult>
    >();
    expectTypeOf<Parameters<SendReceipt.HandlerArgs["commands"]["payOrder"]>>().toEqualTypeOf<
      Parameters<Commands["payOrder"]>
    >();
    expectTypeOf<OnOrderPaid.HandlerArgs["commands"]["payOrder"]>().returns.toEqualTypeOf<
      Promise<ReactionDispatchResult>
    >();
    expectTypeOf<AtNextReminder.DeadlineArgs["commands"]["payOrder"]>().returns.toEqualTypeOf<
      Promise<ReactionDispatchResult>
    >();
    expectTypeOf<Extract<ReactionDispatchResult, { scheduled: false }>>().toMatchObjectType<{
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly version: number;
      readonly eventIds: readonly string[];
      readonly eventTypes: readonly string[];
    }>();
    expectTypeOf<Extract<ReactionDispatchResult, { scheduled: false }>>().not.toHaveProperty(
      "position",
    );
    expectTypeOf<Extract<DispatchResult, { scheduled: false }>>().toHaveProperty("position");
  });
});

describe("policies for another aggregate's events", () => {
  it("receive the event of the aggregate their folder names", () => {
    expectTypeOf<GreetOnCustomerRegistered.HandlerArgs["event"]>().toEqualTypeOf<
      StoredEvent<"CustomerRegistered", { email: string }>
    >();
    expectTypeOf<GreetOnCustomerRegistered.HandlerArgs["commands"]>().toHaveProperty("payOrder");
  });
});

describe("processes", () => {
  it("expose every event of the app by aggregate, as qualified literals, in config", () => {
    expectTypeOf<keyof OrderPayment.ConfigArgs["events"]>().toEqualTypeOf<"customer" | "order">();
    expectTypeOf<keyof OrderPayment.ConfigArgs["events"]["order"]>().toEqualTypeOf<
      "OrderPlaced" | "OrderPaid" | "OrderCancelled"
    >();
    expectTypeOf<
      OrderPayment.ConfigArgs["events"]["order"]["OrderPaid"]
    >().toEqualTypeOf<"order.OrderPaid">();
    expectTypeOf<
      OrderPayment.ConfigArgs["events"]["customer"]["CustomerRegistered"]
    >().toEqualTypeOf<"customer.CustomerRegistered">();
    expectTypeOf<OrderPayment.ConfigArgs["events"]["order"]>().not.toHaveProperty("OrderPlacd");
  });

  it("type correlate by aggregate and event, from the event to an instance id or null", () => {
    type Correlator = NonNullable<
      NonNullable<OrderPayment.Correlate["customer"]>["CustomerRegistered"]
    >;
    expectTypeOf<Parameters<Correlator>[0]>().toEqualTypeOf<
      StoredEvent<"CustomerRegistered", { email: string }>
    >();
    expectTypeOf<ReturnType<Correlator>>().toEqualTypeOf<string | null>();
  });

  it("type a handler for another aggregate's event against that aggregate", () => {
    expectTypeOf<OnCustomerRegistered.HandlerArgs["event"]>().toEqualTypeOf<
      StoredEvent<"CustomerRegistered", { email: string }>
    >();
    expectTypeOf<OnCustomerRegistered.HandlerArgs["state"]["reminders"]>().toEqualTypeOf<number>();
  });

  it("type state from the state schema and the event from the file name", () => {
    expectTypeOf<OnOrderPaid.HandlerArgs["state"]["reminders"]>().toEqualTypeOf<number>();
    expectTypeOf<
      OnOrderPaid.HandlerArgs["event"]["payload"]["reference"]
    >().toEqualTypeOf<string>();
    expectTypeOf<AtTimeout.DeadlineArgs["state"]["reminders"]>().toEqualTypeOf<number>();
    expectTypeOf<AtTimeout.DeadlineArgs["aggregateId"]>().toEqualTypeOf<string>();
    expectTypeOf<AtTimeout.DeadlineArgs>().not.toHaveProperty("event");
  });

  it("type deadlines and recorded moments as nullable instants", () => {
    expectTypeOf<
      OnOrderPaid.HandlerArgs["state"]["nextReminder"]
    >().toEqualTypeOf<Instant | null>();
    expectTypeOf<OnOrderPaid.HandlerArgs["state"]["paidAt"]>().toEqualTypeOf<Instant | null>();
    expectTypeOf<AtTimeout.DeadlineArgs["state"]["nextReminder"]>().toEqualTypeOf<Instant | null>();
    expectTypeOf<Instant>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<Instant>();
  });

  it("narrow the deadline that came due in its at- handler, and only that one", () => {
    expectTypeOf<AtNextReminder.DeadlineArgs["state"]["nextReminder"]>().toEqualTypeOf<Instant>();
    expectTypeOf<AtNextReminder.DeadlineArgs["state"]["paidAt"]>().toEqualTypeOf<Instant | null>();
    expectTypeOf<AtNextReminder.DeadlineArgs["state"]["reminders"]>().toEqualTypeOf<number>();
  });

  it("give every process handler after(), from a duration to an instant", () => {
    expectTypeOf<OnOrderPaid.HandlerArgs["after"]>().parameter(0).toEqualTypeOf<DurationInput>();
    expectTypeOf<OnOrderPaid.HandlerArgs["after"]>().returns.toEqualTypeOf<Instant>();
    expectTypeOf<AtNextReminder.DeadlineArgs["after"]>().returns.toEqualTypeOf<Instant>();
    expectTypeOf<AtTimeout.DeadlineArgs["after"]>().returns.toEqualTypeOf<Instant>();
    expectTypeOf<OnCustomerRegistered.HandlerArgs["after"]>().returns.toEqualTypeOf<Instant>();
  });

  it("hand the state schema deadline() and instant() next to z", () => {
    expectTypeOf<OrderPayment.StateArgs>().toHaveProperty("z");
    expectTypeOf<OrderPayment.StateArgs>().toHaveProperty("deadline");
    expectTypeOf<OrderPayment.StateArgs>().toHaveProperty("instant");
  });
});

describe("read models", () => {
  it("derive the row type from fields, with optional columns optional", () => {
    expectTypeOf<ProjectOrderPaid.Args["table"]>().toEqualTypeOf<Table<OrderSummaryRow>>();
    expectTypeOf<ProjectOrderPaid.Args["event"]["type"]>().toEqualTypeOf<"OrderPaid">();
  });

  it("type repositoryData from what repository returns", () => {
    expectTypeOf<GetOrder.HandlerArgs["repositoryData"]>().toEqualTypeOf<OrderSummaryRow | null>();
    expectTypeOf<ListUnpaidOrders.HandlerArgs["repositoryData"]>().toEqualTypeOf<
      readonly OrderSummaryRow[]
    >();
    expectTypeOf<GetOrder.RepositoryArgs["orderId"]>().toEqualTypeOf<string>();
  });

  it("let a query compose other queries through the typed facade", () => {
    expectTypeOf<CustomerOverview.HandlerArgs["queries"]>().toHaveProperty("getOrder");
    expectTypeOf<Queries["customerOverview"]>().returns.toEqualTypeOf<
      Promise<{ unpaidCount: number; outstanding: number; lastStatus: string | null }>
    >();
  });
});

describe("facades", () => {
  it("expose every command with its payload and dispatch options", () => {
    expectTypeOf<Commands>().toHaveProperty("placeOrder");
    expectTypeOf<Commands>().toHaveProperty("registerCustomer");
    expectTypeOf<Commands["payOrder"]>().parameter(0).toEqualTypeOf<{
      orderId: string;
      method: "card" | "transfer";
      reference: string;
    }>();
    expectTypeOf<Commands["payOrder"]>().parameter(1).toEqualTypeOf<DispatchOptions | undefined>();
    expectTypeOf<Commands["payOrder"]>().returns.toEqualTypeOf<Promise<DispatchResult>>();
    expectTypeOf<Extract<DispatchResult, { scheduled: false }>>().toMatchObjectType<{
      readonly eventTypes: readonly string[];
      readonly position: number;
    }>();
    expectTypeOf<BoundaApp<Registry>["catchUpReadModels"]>()
      .parameter(0)
      .toEqualTypeOf<CatchUpReadModelsArgs | undefined>();
    expectTypeOf<CatchUpReadModelsArgs["through"]>().toEqualTypeOf<DispatchResult | undefined>();
  });

  it("match the facades derived from the runtime registry", () => {
    expectTypeOf<CommandsFacade<Registry>>().toEqualTypeOf<Commands>();
    expectTypeOf<QueriesFacade<Registry>>().toEqualTypeOf<Queries>();
  });

  it("are the project's through register.d.ts, without a type argument", () => {
    expectTypeOf<AppRegistry>().toEqualTypeOf<Registry>();
    expectTypeOf<BoundaApp["commands"]>().toEqualTypeOf<Commands>();
    expectTypeOf<BoundaApp["queries"]>().toEqualTypeOf<Queries>();
  });

  it("expose every query with the result type its handler returns", () => {
    expectTypeOf<Queries["getOrder"]>().returns.toEqualTypeOf<Promise<OrderSummaryRow | null>>();
    expectTypeOf<Queries["listUnpaidOrders"]>().returns.toEqualTypeOf<
      Promise<{ orders: readonly OrderSummaryRow[]; outstanding: number }>
    >();
    expectTypeOf<Queries["listUnpaidOrders"]>()
      .parameter(0)
      .toEqualTypeOf<{ customerId: string; limit?: number | undefined }>();
  });

  it("apply defaults before the repository and the handler see the payload", () => {
    expectTypeOf<ListUnpaidOrders.RepositoryArgs["limit"]>().toEqualTypeOf<number>();
    expectTypeOf<
      ListUnpaidOrders.HandlerArgs["query"]["payload"]["limit"]
    >().toEqualTypeOf<number>();
  });
});
