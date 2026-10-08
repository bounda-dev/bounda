import type {
  AppRegistry,
  BoundaApp,
  CatchUpReadModelsArgs,
  Clock,
  CommandInvoker,
  CommandsFacade,
  CreateArgs,
  CreateImplementation,
  DecidedDispatch,
  DispatchOptions,
  DispatchResult,
  DomainError,
  DurationInput,
  EnvSection,
  ImplementationModule,
  Instant,
  Logger,
  ProcessCorrelation,
  QueriesFacade,
  ReactionDispatchResult,
  RejectedDispatch,
  RejectFunction,
  RejectionCodeOf,
  ScheduledDispatch,
  StoredDispatch,
  StoredEvent,
  Table,
} from "@bounda-dev/core";
import { idempotencyKeyFor } from "@bounda-dev/core";
import { describe, expectTypeOf, it } from "vitest";
import type { registry } from "./fixtures/order-app/.bounda/registry.ts";
import type { Commands, Queries } from "./fixtures/order-app/.bounda/types.ts";
import type { Event as CustomerRegistered } from "./fixtures/order-app/app/domain/customer/+types/customer-registered.ts";
import type { Command as RegisterCustomer } from "./fixtures/order-app/app/domain/customer/commands/+types/register-customer.ts";
import type { Event as OrderPlaced } from "./fixtures/order-app/app/domain/order/+types/order-placed.ts";
import type { Command as CancelOrder } from "./fixtures/order-app/app/domain/order/commands/+types/cancel-order.ts";
import type { Command as PayOrder } from "./fixtures/order-app/app/domain/order/commands/+types/pay-order.ts";
import type { Command as PlaceOrder } from "./fixtures/order-app/app/domain/order/commands/+types/place-order.ts";
import type { Policy as NotifyOnOrderPlaced } from "./fixtures/order-app/app/domain/order/policies/+types/notify-on-order-placed.ts";
import type { Policy as SendReceipt } from "./fixtures/order-app/app/domain/order/policies/+types/send-receipt-on-order-paid.ts";
import type { Policy as GreetOnCustomerRegistered } from "./fixtures/order-app/app/domain/order/policies/customer/+types/greet-on-customer-registered.ts";
import type { Process as AtNextReminder } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/at-next-reminder.ts";
import type { Process as AtTimeout } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/at-timeout.ts";
import type { Process as OrderPayment } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/index.ts";
import type { Process as OnOrderPaid } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/on-order-paid.ts";
import type { Process as OnCustomerRegistered } from "./fixtures/order-app/app/domain/order/processes/order-payment/customer/+types/on-customer-registered.ts";
import type { Projection as ProjectOrderPaid } from "./fixtures/order-app/app/read/order-summary/projections/order/+types/order-paid.ts";
import type { Query as CustomerOverview } from "./fixtures/order-app/app/read/order-summary/queries/+types/customer-overview.ts";
import type { Query as GetOrder } from "./fixtures/order-app/app/read/order-summary/queries/+types/get-order.ts";
import type { Query as ListUnpaidOrders } from "./fixtures/order-app/app/read/order-summary/queries/+types/list-unpaid-orders.ts";

type Registry = typeof registry;

declare const commands: Commands;
declare const reactionCommands: SendReceipt.HandlerArgs["commands"];
declare const options: DispatchOptions;
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

  it("reaches evolve as well", () => {
    expectTypeOf<OrderPlaced.EvolveArgs["state"]["status"]>().toEqualTypeOf<OrderStatus>();
    expectTypeOf<
      OrderPlaced.EvolveArgs["event"]["payload"]["customerId"]
    >().toEqualTypeOf<string>();
    expectTypeOf<OrderPlaced.EvolveArgs["event"]["type"]>().toEqualTypeOf<"OrderPlaced">();
    expectTypeOf<CustomerRegistered.EvolveArgs["state"]["active"]>().toEqualTypeOf<boolean>();
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

describe("ports", () => {
  type Inventory = import("./fixtures/order-app/app/domain/order/inventory.ts").Inventory;
  type Reminders = import("./fixtures/order-app/app/domain/order/reminders.ts").Reminders;
  type InventoryFake =
    typeof import("./fixtures/order-app/app/domain/order/infrastructure/inventory/fake.ts");
  type InventoryHttp =
    typeof import("./fixtures/order-app/app/domain/order/infrastructure/inventory/http.ts");
  type RemindersFake =
    typeof import("./fixtures/order-app/app/domain/order/infrastructure/reminders/fake.ts");

  it("are typed by the interface each port's module exports", () => {
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

  it("type an implementation by the port it satisfies, without +types of its own", () => {
    expectTypeOf<InventoryFake["default"]>().toExtend<Inventory>();
    expectTypeOf<RemindersFake["default"]>().toExtend<Reminders>();
  });

  it("type create by the port, with the host's environment, the logger and the clock", () => {
    expectTypeOf<InventoryHttp["create"]>().toEqualTypeOf<CreateImplementation<Inventory>>();
    expectTypeOf<Parameters<InventoryHttp["create"]>[0]>().toEqualTypeOf<CreateArgs>();
    expectTypeOf<CreateArgs["env"]>().toEqualTypeOf<Readonly<Record<string, string | undefined>>>();
    expectTypeOf<CreateArgs["logger"]>().toEqualTypeOf<Logger>();
    expectTypeOf<CreateArgs["clock"]>().toEqualTypeOf<Clock>();
    expectTypeOf<ReturnType<InventoryHttp["create"]>>().toEqualTypeOf<
      Inventory | Promise<Inventory>
    >();
  });

  it("leave the aggregate's other modules out of the registry and the events", () => {
    expectTypeOf<Registry["aggregates"]["order"]["events"]>().not.toHaveProperty("money");
    expectTypeOf<PlaceOrder.HandlerArgs["events"]>().not.toHaveProperty("money");
    expectTypeOf<PlaceOrder.HandlerArgs>().not.toHaveProperty("money");
  });

  it("leave env optional for createApp and createTestApp when no host registers one", () => {
    expectTypeOf<EnvSection>().toEqualTypeOf<{
      readonly env?: Readonly<Record<string, string | undefined>>;
    }>();
    // inventory/http.ts exports create, and an empty object is still a valid environment.
    expectTypeOf<EnvSection<typeof registry>>().toEqualTypeOf<{
      readonly env?: Readonly<Record<string, string | undefined>>;
    }>();
  });

  it("accept an implementation module with a default export or with a create, sync or async", () => {
    const withDefault = {
      default: { reserve: async () => {} },
    } satisfies ImplementationModule<Inventory>;
    const withCreate = {
      create: () => ({ reserve: async () => {} }),
    } satisfies ImplementationModule<Inventory>;
    const withAsyncCreate = {
      create: async ({ env }: CreateArgs) => {
        const url = env.INVENTORY_URL;
        return { reserve: async () => void url };
      },
    } satisfies ImplementationModule<Inventory>;
    void [withDefault, withCreate, withAsyncCreate];
  });
});

describe("rejections", () => {
  it("give reject the codes the command declares, returning the error to return or throw", () => {
    expectTypeOf<PayOrder.HandlerArgs["reject"]>().toEqualTypeOf<RejectFunction<"NotPlaced">>();
    expectTypeOf<PayOrder.HandlerArgs["reject"]>().parameter(0).toEqualTypeOf<"NotPlaced">();
    expectTypeOf<PayOrder.HandlerArgs["reject"]>().returns.toEqualTypeOf<
      DomainError<"NotPlaced">
    >();
    expectTypeOf<DomainError<"NotPlaced">["rejected"]>().toEqualTypeOf<"NotPlaced">();
    expectTypeOf<PlaceOrder.HandlerArgs["reject"]>().toEqualTypeOf<
      RejectFunction<"AlreadyPlaced">
    >();
    expectTypeOf<
      RejectionCodeOf<typeof import("./fixtures/order-app/app/domain/order/commands/pay-order.ts")>
    >().toEqualTypeOf<"NotPlaced">();
  });

  it("give reject only to a command that declares rejections", () => {
    expectTypeOf<CancelOrder.HandlerArgs>().not.toHaveProperty("reject");
    expectTypeOf<RegisterCustomer.HandlerArgs>().not.toHaveProperty("reject");
    expectTypeOf<
      RejectionCodeOf<
        typeof import("./fixtures/order-app/app/domain/order/commands/cancel-order.ts")
      >
    >().toBeNever();
  });

  it("give rejections the command and the state the handler saw", () => {
    expectTypeOf<PayOrder.RejectionsArgs["state"]>().toEqualTypeOf<PayOrder.HandlerArgs["state"]>();
    expectTypeOf<PayOrder.RejectionsArgs["command"]>().toEqualTypeOf<
      PayOrder.HandlerArgs["command"]
    >();
    expectTypeOf<PayOrder.RejectionsArgs>().not.toHaveProperty("events");
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
    expectTypeOf<PlaceOrder.HandlerArgs["signal"]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<PayOrder.HandlerArgs["signal"]>().toEqualTypeOf<AbortSignal>();
  });

  it("derive one per effect from the key a handler receives", () => {
    expectTypeOf(idempotencyKeyFor).toEqualTypeOf<
      (idempotencyKey: string, effect: string) => string
    >();
    expectTypeOf(idempotencyKeyFor)
      .parameter(0)
      .toEqualTypeOf<SendReceipt.HandlerArgs["idempotencyKey"]>();
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
    const payment = { orderId: "o-1", method: "card", reference: "r-1" } as const;
    expectTypeOf<ReturnType<SendReceipt.HandlerArgs["commands"]["payOrder"]>>().toEqualTypeOf<
      Promise<ReactionDispatchResult<"NotPlaced">>
    >();
    expectTypeOf<Parameters<SendReceipt.HandlerArgs["commands"]["payOrder"]>>().toEqualTypeOf<
      Parameters<Commands["payOrder"]>
    >();
    expectTypeOf<ReturnType<OnOrderPaid.HandlerArgs["commands"]["payOrder"]>>().toEqualTypeOf<
      Promise<ReactionDispatchResult<"NotPlaced">>
    >();
    expectTypeOf<ReturnType<AtNextReminder.DeadlineArgs["commands"]["payOrder"]>>().toEqualTypeOf<
      Promise<ReactionDispatchResult<"NotPlaced">>
    >();
    expectTypeOf<DecidedDispatch>().toEqualTypeOf<{
      readonly rejected: false;
      readonly scheduled: false;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly version: number;
      readonly eventIds: readonly string[];
      readonly eventTypes: readonly string[];
    }>();
    expectTypeOf<DecidedDispatch>().not.toHaveProperty("position");
    expectTypeOf<StoredDispatch>().toHaveProperty("position");
    expectTypeOf(reactionCommands.payOrder(payment)).resolves.toEqualTypeOf<
      DecidedDispatch | RejectedDispatch<"NotPlaced">
    >();
    expectTypeOf(reactionCommands.payOrder(payment, { delay: "1h" })).resolves.toEqualTypeOf<
      ScheduledDispatch & { readonly rejected: false }
    >();
    expectTypeOf(reactionCommands.payOrder(payment, options)).resolves.toEqualTypeOf<
      ReactionDispatchResult<"NotPlaced">
    >();
    expectTypeOf(
      reactionCommands.cancelOrder({ orderId: "o-1", reason: "r" }),
    ).resolves.toEqualTypeOf<DecidedDispatch>();
  });

  it("get a rejection as a value, with the codes the command declares", () => {
    type Paid = Awaited<ReturnType<SendReceipt.HandlerArgs["commands"]["payOrder"]>>;
    expectTypeOf<Paid["rejected"]>().toEqualTypeOf<false | "NotPlaced">();
    expectTypeOf<Extract<Paid, { rejected: "NotPlaced" }>>().toEqualTypeOf<{
      readonly rejected: "NotPlaced";
      readonly message: string;
      readonly aggregateType: string;
      readonly aggregateId: string;
    }>();
    expectTypeOf<Extract<Paid, { rejected: "NotPlaced" }>>().not.toHaveProperty("eventIds");
    expectTypeOf<Extract<Paid, { scheduled: true }>>().branded.toEqualTypeOf<{
      readonly rejected: false;
      readonly scheduled: true;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly executeAt: string;
    }>();
  });

  it("get rejected: false only from a command without rejections", () => {
    type Cancelled = Awaited<ReturnType<SendReceipt.HandlerArgs["commands"]["cancelOrder"]>>;
    expectTypeOf<Cancelled["rejected"]>().toEqualTypeOf<false>();
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
    type From = OrderPayment.CorrelateArgs["from"]["customer"]["CustomerRegistered"];
    type Correlator = Parameters<From>[0];
    expectTypeOf<Parameters<Correlator>[0]>().toEqualTypeOf<
      StoredEvent<"CustomerRegistered", { email: string }>
    >();
    expectTypeOf<ReturnType<Correlator>>().toEqualTypeOf<string | null>();
    expectTypeOf<ReturnType<From>>().toEqualTypeOf<ProcessCorrelation>();
    expectTypeOf<keyof OrderPayment.CorrelateArgs["from"]>().toEqualTypeOf<"customer" | "order">();
  });

  it("infer the event of a correlate entry without annotating it", () => {
    const correlate = ({ from }: OrderPayment.CorrelateArgs) => [
      from.customer.CustomerRegistered((event) => {
        expectTypeOf(event.payload).toEqualTypeOf<{ email: string }>();
        return null;
      }),
    ];
    expectTypeOf(correlate).returns.toEqualTypeOf<ProcessCorrelation[]>();
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
    expectTypeOf<Parameters<Commands["payOrder"]>[1]>().toEqualTypeOf<
      DispatchOptions | undefined
    >();
    expectTypeOf<DispatchOptions["signal"]>().toEqualTypeOf<AbortSignal | undefined>();
    expectTypeOf<ReturnType<Commands["payOrder"]>>().toEqualTypeOf<Promise<DispatchResult>>();
    expectTypeOf<DispatchResult>().toEqualTypeOf<StoredDispatch | ScheduledDispatch>();
    expectTypeOf<StoredDispatch>().toEqualTypeOf<{
      readonly scheduled: false;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly version: number;
      readonly eventIds: readonly string[];
      readonly eventTypes: readonly string[];
      readonly position: number;
    }>();
    expectTypeOf<ScheduledDispatch>().toEqualTypeOf<{
      readonly scheduled: true;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly executeAt: string;
    }>();
    expectTypeOf<DispatchResult>().not.toHaveProperty("rejected");
    expectTypeOf<BoundaApp<Registry>["catchUpReadModels"]>()
      .parameter(0)
      .toEqualTypeOf<CatchUpReadModelsArgs | undefined>();
    expectTypeOf<CatchUpReadModelsArgs["through"]>().toEqualTypeOf<DispatchResult | undefined>();
  });

  it("type a command's result by whether it has a delay", async () => {
    const payment = { orderId: "o-1", method: "card", reference: "r-1" } as const;
    const signal = new AbortController().signal;
    expectTypeOf(commands.payOrder(payment)).resolves.toEqualTypeOf<StoredDispatch>();
    expectTypeOf(commands.payOrder(payment, { signal })).resolves.toEqualTypeOf<StoredDispatch>();
    expectTypeOf(
      commands.payOrder(payment, { correlationId: "c-1" }),
    ).resolves.toEqualTypeOf<StoredDispatch>();
    expectTypeOf(
      commands.payOrder(payment, { delay: "1h", signal }),
    ).resolves.toEqualTypeOf<ScheduledDispatch>();
    expectTypeOf(commands.payOrder(payment, options)).resolves.toEqualTypeOf<DispatchResult>();
    expectTypeOf((await commands.payOrder(payment)).eventTypes).toEqualTypeOf<readonly string[]>();
  });

  it("type the result of a command without a payload, or with an optional one, the same way", () => {
    interface Bare {
      readonly handler: () => readonly [];
    }
    interface Loose {
      readonly payload?: unknown;
      readonly handler: () => readonly [];
    }
    const bare = {} as CommandInvoker<Bare>;
    const loose = {} as CommandInvoker<Loose>;
    expectTypeOf(bare()).resolves.toEqualTypeOf<StoredDispatch>();
    expectTypeOf(bare({ delay: "1h" })).resolves.toEqualTypeOf<ScheduledDispatch>();
    expectTypeOf(bare(options)).resolves.toEqualTypeOf<DispatchResult>();
    expectTypeOf(loose()).resolves.toEqualTypeOf<StoredDispatch>();
    expectTypeOf(loose(undefined, { delay: "1h" })).resolves.toEqualTypeOf<ScheduledDispatch>();
    expectTypeOf(loose(undefined, options)).resolves.toEqualTypeOf<DispatchResult>();
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
