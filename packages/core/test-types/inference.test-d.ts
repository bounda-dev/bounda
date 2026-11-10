import type {
  AccessOutcome,
  AfterOptions,
  AppRegistry,
  AppStatus,
  BoundaApp,
  BoundaClient,
  CancelledCommand,
  CatchUpReadModelsArgs,
  CategoryRetentionStatus,
  CausationContext,
  CheckActorFunction,
  Clock,
  CommandHandlerArgs,
  CommandInvoker,
  CommandMetadata,
  CommandPayloadArgs,
  CommandPersonalFunction,
  CommandsFacade,
  Consistency,
  CreateArgs,
  CreateImplementation,
  DeadLetter,
  DeadLetterAccess,
  DeadLetterKind,
  DeadLetterRetentionStatus,
  DecidedDispatch,
  DispatchOptions,
  DispatchResult,
  DomainError,
  DurationInput,
  EmptyPayload,
  EnvSection,
  EventMetadata,
  EventPayloadArgs,
  ExportedCategories,
  ExportedCategory,
  ExportedData,
  ExportedDeadLetter,
  ExportedEvent,
  ExportedRow,
  ExportedScheduledCommand,
  ExportedSubscriberFailure,
  Field,
  FieldFilter,
  FieldsArgs,
  FieldTypes,
  FieldTypesOf,
  FieldTypesOfRow,
  ForgetLedgerReconciliationStatus,
  ForgetOptions,
  ForgetsPersonalData,
  HasPersonalFields,
  ImplementationModule,
  Instant,
  KeyRotationStatus,
  LegalBasis,
  Logger,
  OnPersonalDataAccess,
  OnPersonalDataAccessArgs,
  PayloadArgs,
  PayloadInputOf,
  PersonalCategoryName,
  PersonalDataAccess,
  PersonalDataBackfillLag,
  PersonalDataCategories,
  PersonalDataCategory,
  PersonalDataExport,
  PersonalDataForgottenEvent,
  PersonalDataForgottenPayload,
  PersonalDataForgottenReason,
  PersonalFunction,
  PersonalOptions,
  PersonFunction,
  ProcessCorrelation,
  ProcessingRestrictedEvent,
  ProcessingRestrictedPayload,
  ProcessingRestrictionLiftedEvent,
  ProcessingRestrictionLiftedPayload,
  ProcessStatus,
  QueriesFacade,
  RangeFilter,
  ReactionDispatchResult,
  ReactionForgetFunction,
  ReadClient,
  ReadEventsArgs,
  RejectedDispatch,
  RejectFunction,
  RejectionCodeOf,
  RemovedDeadLetter,
  RetentionInput,
  RetentionStatus,
  ScheduledDispatch,
  SchemaStatus,
  SetFilter,
  StoredDispatch,
  StoredEvent,
  SubscriberFailure,
  SubscriberFailureStatus,
  SubscriberFailures,
  Table,
  Where,
} from "@bounda-dev/core";
import {
  checkActor,
  fieldBuilder,
  idempotencyKeyFor,
  MAX_ACCESS_PERSONS,
  MAX_ACTOR_LENGTH,
} from "@bounda-dev/core";
import type {
  Adapter,
  ForgetLedger,
  SchemaScopeName,
  SchemaVersion,
  StoredSubscriberFailure,
} from "@bounda-dev/core/adapter";
import { describe, expectTypeOf, it } from "vitest";
import type { registry } from "./fixtures/order-app/.bounda/registry.ts";
import type {
  Commands,
  CustomerDirectoryFieldTypes,
  CustomerDirectoryForgetting,
  CustomerDirectoryRow,
  OrderSummaryRow as GeneratedOrderSummaryRow,
  OrderSummaryFieldTypes,
  OrderSummaryForgetting,
  PersonalCategory,
  PersonalDataDeclaration,
  Queries,
} from "./fixtures/order-app/.bounda/types.ts";
import type { PersonalData } from "./fixtures/order-app/app/+types/personal-data.ts";
import type * as audit from "./fixtures/order-app/app/audit.ts";
import type { Event as CustomerRegistered } from "./fixtures/order-app/app/domain/customer/+types/customer-registered.ts";
import type { Command as RegisterCustomer } from "./fixtures/order-app/app/domain/customer/commands/+types/register-customer.ts";
import type { Event as OrderPlaced } from "./fixtures/order-app/app/domain/order/+types/order-placed.ts";
import type { Command as CancelOrder } from "./fixtures/order-app/app/domain/order/commands/+types/cancel-order.ts";
import type { Command as PayOrder } from "./fixtures/order-app/app/domain/order/commands/+types/pay-order.ts";
import type { Command as PlaceOrder } from "./fixtures/order-app/app/domain/order/commands/+types/place-order.ts";
import type { Policy as NotifyOnOrderPlaced } from "./fixtures/order-app/app/domain/order/policies/+types/notify-on-order-placed.ts";
import type { Policy as SendReceipt } from "./fixtures/order-app/app/domain/order/policies/+types/send-receipt-on-order-paid.ts";
import type { Policy as AuditOnPersonalDataForgotten } from "./fixtures/order-app/app/domain/order/policies/bounda/+types/audit-on-personal-data-forgotten.ts";
import type { Policy as AuditOnProcessingRestrictionLifted } from "./fixtures/order-app/app/domain/order/policies/bounda/+types/audit-on-processing-restriction-lifted.ts";
import type { Policy as GreetOnCustomerRegistered } from "./fixtures/order-app/app/domain/order/policies/customer/+types/greet-on-customer-registered.ts";
import type { Process as AtNextReminder } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/at-next-reminder.ts";
import type { Process as AtTimeout } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/at-timeout.ts";
import type { Process as OrderPayment } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/index.ts";
import type { Process as OnOrderPaid } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/on-order-paid.ts";
import type { Process as OnCustomerRegistered } from "./fixtures/order-app/app/domain/order/processes/order-payment/customer/+types/on-customer-registered.ts";
import type { Projection as ProjectCustomerRegistered } from "./fixtures/order-app/app/read/customer-directory/projections/customer/+types/customer-registered.ts";
import type { Query as GetCustomer } from "./fixtures/order-app/app/read/customer-directory/queries/+types/get-customer.ts";
import type { Projection as ProjectForgotten } from "./fixtures/order-app/app/read/order-summary/projections/bounda/+types/personal-data-forgotten.ts";
import type { Projection as ProjectRestricted } from "./fixtures/order-app/app/read/order-summary/projections/bounda/+types/processing-restricted.ts";
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

  it("reads who acts from the command's metadata, when anyone was named", () => {
    expectTypeOf<PlaceOrder.HandlerArgs["command"]["metadata"]>().toEqualTypeOf<CommandMetadata>();
    expectTypeOf<CommandMetadata["actor"]>().toEqualTypeOf<string | undefined>();
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
  it("take what the payload schema takes as input, which validation turns into its output", () => {
    const shipped = {
      payload: ({ z }: PayloadArgs) =>
        z.object({ at: z.string().transform(Number), carrier: z.string().default("post") }),
      evolve: () => ({}),
    };
    type Events = { readonly shipped: typeof shipped };
    type Shipped = CommandHandlerArgs<
      "Ship",
      EmptyPayload,
      object,
      Events,
      object
    >["events"]["shipped"];
    expectTypeOf<Shipped>()
      .parameter(0)
      .toEqualTypeOf<{ at: string; carrier?: string | undefined }>();
    expectTypeOf<ReturnType<Shipped>["payload"]>().toEqualTypeOf<{
      at: string;
      carrier?: string | undefined;
    }>();
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

  it("type create by the port, with the host's environment, the tenant, the logger and the clock", () => {
    expectTypeOf<InventoryHttp["create"]>().toEqualTypeOf<CreateImplementation<Inventory>>();
    expectTypeOf<Parameters<InventoryHttp["create"]>[0]>().toEqualTypeOf<CreateArgs>();
    expectTypeOf<CreateArgs["env"]>().toEqualTypeOf<Readonly<Record<string, string | undefined>>>();
    expectTypeOf<Pick<CreateArgs, "tenant">>().toEqualTypeOf<{ readonly tenant?: string }>();
    expectTypeOf<CreateArgs["logger"]>().toEqualTypeOf<Logger>();
    expectTypeOf<CreateArgs["clock"]>().toEqualTypeOf<Clock>();
    expectTypeOf<ReturnType<InventoryHttp["create"]>>().toEqualTypeOf<
      Inventory | Promise<Inventory>
    >();
  });

  it("type a clock's waits, taking one that may let the process go, and a clock that ignores it", () => {
    expectTypeOf<Parameters<Clock["after"]>[2]>().toEqualTypeOf<AfterOptions | undefined>();
    expectTypeOf<AfterOptions>().toEqualTypeOf<{ readonly background?: boolean }>();
    expectTypeOf<{
      now(): Date;
      after(milliseconds: number, callback: () => void): () => void;
    }>().toExtend<Clock>();
  });

  it("reach a read model's query handlers, and neither its repository nor its projections", () => {
    type Rates = import("./fixtures/order-app/app/read/order-summary/rates.ts").Rates;
    expectTypeOf<CustomerOverview.HandlerArgs["rates"]>().toEqualTypeOf<Rates>();
    expectTypeOf<CustomerOverview.RepositoryArgs>().not.toHaveProperty("rates");
    expectTypeOf<ProjectOrderPaid.Args>().not.toHaveProperty("rates");
    expectTypeOf<PlaceOrder.HandlerArgs>().not.toHaveProperty("rates");
  });

  it("carries the state fingerprint the generator computed for every aggregate", () => {
    expectTypeOf<Registry["aggregates"]["order"]["stateFingerprint"]>().toBeString();
    expectTypeOf<Registry["aggregates"]["customer"]["stateFingerprint"]>().toBeString();
    expectTypeOf<Registry["aggregates"]["order"]["stateFingerprint"]>().not.toEqualTypeOf<
      string | undefined
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
    const byTenant = {
      create: ({ env, tenant = "default" }: CreateArgs) => {
        const key = env[`INVENTORY_KEY_${tenant.toUpperCase()}`];
        return { reserve: async () => void key };
      },
    } satisfies ImplementationModule<Inventory>;
    void [withDefault, withCreate, withAsyncCreate, byTenant];
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

  it("lets policies and processes forget a person with their run, and no command handler", () => {
    expectTypeOf<ReactionForgetFunction>().toEqualTypeOf<
      (personId: string, options?: ForgetOptions) => Promise<void>
    >();
    expectTypeOf<SendReceipt.HandlerArgs["forget"]>().toEqualTypeOf<ReactionForgetFunction>();
    expectTypeOf<
      NotifyOnOrderPlaced.HandlerArgs["forget"]
    >().toEqualTypeOf<ReactionForgetFunction>();
    expectTypeOf<
      AuditOnPersonalDataForgotten.HandlerArgs["forget"]
    >().toEqualTypeOf<ReactionForgetFunction>();
    expectTypeOf<OnOrderPaid.HandlerArgs["forget"]>().toEqualTypeOf<ReactionForgetFunction>();
    expectTypeOf<AtTimeout.DeadlineArgs["forget"]>().toEqualTypeOf<ReactionForgetFunction>();
    expectTypeOf<AtNextReminder.DeadlineArgs["forget"]>().toEqualTypeOf<ReactionForgetFunction>();
    expectTypeOf<PlaceOrder.HandlerArgs>().not.toHaveProperty("forget");
    expectTypeOf<PayOrder.HandlerArgs>().not.toHaveProperty("forget");
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

  it("read the event's cause, and the command that wrote it when one did", () => {
    type Metadata = SendReceipt.HandlerArgs["event"]["metadata"];
    expectTypeOf<Metadata["causationId"]>().toEqualTypeOf<string>();
    expectTypeOf<Metadata["commandId"]>().toEqualTypeOf<string | undefined>();
  });

  it("read who acted on the event, when anyone was named", () => {
    type Metadata = SendReceipt.HandlerArgs["event"]["metadata"];
    expectTypeOf<Metadata["actor"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<CausationContext["actor"]>().toEqualTypeOf<string | undefined>();
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

describe("personal data", () => {
  type CustomerRegisteredModule =
    typeof import("./fixtures/order-app/app/domain/customer/customer-registered.ts");
  type OrderPlacedModule = typeof import("./fixtures/order-app/app/domain/order/order-placed.ts");
  type OrderPaidModule = typeof import("./fixtures/order-app/app/domain/order/order-paid.ts");

  it("gives an event's and a command's payload the marks, and a query's none", () => {
    expectTypeOf<CustomerRegistered.PayloadArgs>().toEqualTypeOf<EventPayloadArgs>();
    expectTypeOf<EventPayloadArgs["personal"]>().toEqualTypeOf<PersonalFunction>();
    expectTypeOf<EventPayloadArgs["person"]>().toEqualTypeOf<PersonFunction>();
    expectTypeOf<RegisterCustomer.PayloadArgs>().toEqualTypeOf<CommandPayloadArgs>();
    expectTypeOf<CommandPayloadArgs["personal"]>().toEqualTypeOf<CommandPersonalFunction>();
    expectTypeOf<CommandPayloadArgs["person"]>().toEqualTypeOf<PersonFunction>();
    expectTypeOf<GetOrder.PayloadArgs>().toEqualTypeOf<PayloadArgs>();
    expectTypeOf<PayloadArgs>().not.toHaveProperty("personal");
  });

  it("hands a command's handler its personal fields as its schema gives them, never null", () => {
    type RegisterCustomerModule =
      typeof import("./fixtures/order-app/app/domain/customer/commands/register-customer.ts");
    expectTypeOf<RegisterCustomer.HandlerArgs["command"]["payload"]>().toEqualTypeOf<{
      customerId: string;
      email: string;
    }>();
    expectTypeOf<PayloadInputOf<RegisterCustomerModule>>().toEqualTypeOf<{
      customerId: string;
      email: string;
    }>();
  });

  it("writes a personal field as its schema takes it and reads it as that or null", () => {
    expectTypeOf<RegisterCustomer.HandlerArgs["events"]["customerRegistered"]>()
      .parameter(0)
      .toEqualTypeOf<{ email: string }>();
    expectTypeOf<CustomerRegistered.EvolveArgs["event"]["payload"]["email"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<ProjectCustomerRegistered.Args["event"]["payload"]["email"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<PlaceOrder.HandlerArgs["events"]["orderPlaced"]>().parameter(0).toMatchTypeOf<{
      customerId: string;
      note?: string | undefined;
    }>();
    expectTypeOf<OrderPlaced.EvolveArgs["event"]["payload"]["note"]>().toEqualTypeOf<
      string | null | undefined
    >();
  });

  it("leaves the person field's type as it is", () => {
    expectTypeOf<
      OrderPlaced.EvolveArgs["event"]["payload"]["customerId"]
    >().toEqualTypeOf<string>();
    expectTypeOf<PlaceOrder.HandlerArgs["events"]["orderPlaced"]>()
      .parameter(0)
      .toHaveProperty("customerId")
      .toEqualTypeOf<string>();
  });

  it("tells the modules with personal fields apart, wrapped or not", () => {
    expectTypeOf<HasPersonalFields<CustomerRegisteredModule>>().toEqualTypeOf<true>();
    expectTypeOf<HasPersonalFields<OrderPlacedModule>>().toEqualTypeOf<true>();
    expectTypeOf<HasPersonalFields<OrderPaidModule>>().toEqualTypeOf<false>();
    expectTypeOf<HasPersonalFields<OrderPaidModule | OrderPlacedModule>>().toEqualTypeOf<boolean>();
    expectTypeOf<HasPersonalFields<{ evolve: () => object }>>().toEqualTypeOf<false>();
  });

  it("marks read-model fields without changing their rows, a person field being a string", () => {
    expectTypeOf(fieldBuilder.string().person()).toEqualTypeOf<
      Field<string, false, "person", "string">
    >();
    expectTypeOf(fieldBuilder.string().optional().personal()).toEqualTypeOf<
      Field<string, true, "personal", "string">
    >();
    expectTypeOf(fieldBuilder.json<{ street: string }>().personal().index()).toEqualTypeOf<
      Field<{ street: string }, false, "personal", "json">
    >();
    expectTypeOf(fieldBuilder.string().mark).toEqualTypeOf<null>();
    expectTypeOf<CustomerDirectoryRow>().toEqualTypeOf<{
      readonly customerId: string;
      readonly email?: string;
      readonly tier?: "regular" | "vip";
      readonly newsletter?: boolean;
    }>();
    const view = {
      fields: ({ f }: FieldsArgs) => ({
        customerId: f.string().primaryKey().person(),
        email: f.string().personal(),
      }),
    };
    expectTypeOf<
      ForgetsPersonalData<"customers", never, true, typeof view>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      ForgetsPersonalData<"customers", never, false, typeof view>
    >().toEqualTypeOf<"Read model customers has fields marked .personal(), so it needs projections/bounda/personal-data-forgotten.ts">();
    const unidentified = {
      fields: ({ f }: FieldsArgs) => ({
        id: f.string().primaryKey(),
        email: f.string().personal(),
      }),
    };
    expectTypeOf<
      ForgetsPersonalData<"customers", never, true, typeof unidentified>
    >().toEqualTypeOf<"Read model customers has fields marked .personal(), so it needs a field marked .person(): the id of the person they belong to">();
    const twoPersons = {
      fields: ({ f }: FieldsArgs) => ({
        id: f.string().primaryKey().person(),
        customerId: f.string().person(),
      }),
    };
    expectTypeOf<
      ForgetsPersonalData<"customers", never, true, typeof twoPersons>
    >().toEqualTypeOf<"Read model customers marks more than one field with .person(); keep the one that names whose the row is">();
    // A person field alone holds an id, which needs no forgetting.
    const idOnly = { fields: ({ f }: FieldsArgs) => ({ id: f.string().primaryKey().person() }) };
    expectTypeOf<
      ForgetsPersonalData<"customers", never, false, typeof idOnly>
    >().toEqualTypeOf<true>();
  });

  it("types the access log's hook and the records it receives", () => {
    expectTypeOf<Registry["audit"]>().toEqualTypeOf<typeof audit>();
    expectTypeOf<typeof audit.onPersonalDataAccess>().toEqualTypeOf<OnPersonalDataAccess>();
    expectTypeOf<OnPersonalDataAccessArgs["access"]>().toEqualTypeOf<PersonalDataAccess>();
    expectTypeOf<OnPersonalDataAccessArgs["tenant"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<OnPersonalDataAccessArgs["logger"]>().toEqualTypeOf<Logger>();
    expectTypeOf<PersonalDataAccess["operation"]>().toEqualTypeOf<
      | "query"
      | "exportPersonalData"
      | "deadLetters.list"
      | "deadLetters.get"
      | "deadLetters.retry"
      | "deadLetters.discard"
      | "subscriberFailures.list"
      | "subscriberFailures.get"
    >();
    expectTypeOf<PersonalDataAccess["actor"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PersonalDataAccess["persons"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<PersonalDataAccess["personCount"]>().toEqualTypeOf<number>();
    expectTypeOf<PersonalDataAccess["at"]>().toEqualTypeOf<string>();
    expectTypeOf<Extract<PersonalDataAccess, { operation: "query" }>["detail"]>().toEqualTypeOf<{
      readonly query: string;
      readonly readModel: string;
    }>();
    expectTypeOf<DeadLetter["resolvedAt"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DeadLetterAccess["operation"]>().toEqualTypeOf<
      "deadLetters.get" | "deadLetters.retry" | "deadLetters.discard"
    >();
    expectTypeOf<DeadLetterAccess["detail"]>().toEqualTypeOf<{ readonly letter: string }>();
    expectTypeOf<
      Extract<PersonalDataAccess, { operation: "deadLetters.list" }>["detail"]
    >().toEqualTypeOf<{ readonly letters: number }>();
    expectTypeOf<
      Extract<PersonalDataAccess, { operation: "subscriberFailures.list" }>["detail"]
    >().toEqualTypeOf<{ readonly failures: number }>();
    expectTypeOf<
      Extract<PersonalDataAccess, { operation: "subscriberFailures.get" }>["detail"]
    >().toEqualTypeOf<{ readonly subscriber: string }>();
    expectTypeOf<
      Extract<PersonalDataAccess, { operation: "exportPersonalData" }>["detail"]
    >().toEqualTypeOf<{
      readonly events: number;
      readonly scheduledCommands: number;
      readonly deadLetters: number;
      readonly subscriberFailures: number;
      readonly readModelRows: number;
    } | null>();
    expectTypeOf<PersonalDataAccess["outcome"]>().toEqualTypeOf<AccessOutcome>();
    expectTypeOf<AccessOutcome>().toEqualTypeOf<"ok" | "failed">();
    expectTypeOf<
      Extract<PersonalDataAccess, { operation: "query" }>["unattributed"]
    >().toEqualTypeOf<boolean>();
    expectTypeOf(MAX_ACCESS_PERSONS).toEqualTypeOf<number>();
  });

  it("requires a read model projecting personal fields to handle forgetting", () => {
    expectTypeOf<CustomerDirectoryForgetting>().toEqualTypeOf<true>();
    expectTypeOf<OrderSummaryForgetting>().toEqualTypeOf<true>();
    expectTypeOf<ForgetsPersonalData<"x", OrderPaidModule, false>>().toEqualTypeOf<true>();
    expectTypeOf<
      ForgetsPersonalData<"x", OrderPaidModule | OrderPlacedModule, true>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      ForgetsPersonalData<"orderSummary", OrderPaidModule | OrderPlacedModule, false>
    >().toEqualTypeOf<"Read model orderSummary projects personal data, so it needs projections/bounda/personal-data-forgotten.ts">();
  });

  it("types the runtime's event for the projections and policies that handle it", () => {
    expectTypeOf<ProjectForgotten.Args["event"]>().toEqualTypeOf<PersonalDataForgottenEvent>();
    expectTypeOf<
      ProjectForgotten.Args["event"]["payload"]
    >().toEqualTypeOf<PersonalDataForgottenPayload>();
    expectTypeOf<ProjectForgotten.Args["event"]["type"]>().toEqualTypeOf<"PersonalDataForgotten">();
    expectTypeOf<PersonalDataForgottenPayload>().toEqualTypeOf<{
      readonly personId: string;
      readonly reason: PersonalDataForgottenReason;
      readonly whole: boolean;
      readonly categories: readonly PersonalCategoryName[];
      readonly retained: readonly PersonalCategoryName[];
      readonly expired: readonly PersonalCategoryName[];
      readonly fingerprints?: readonly string[];
      readonly cancelledCommands: readonly CancelledCommand[];
      readonly removedDeadLetters: readonly RemovedDeadLetter[];
    }>();
    expectTypeOf<PersonalCategoryName>().toEqualTypeOf<"default" | "delivery" | "invoices">();
    expectTypeOf<PersonalDataForgottenReason>().toEqualTypeOf<"requested" | "retention">();
    expectTypeOf<
      AuditOnPersonalDataForgotten.HandlerArgs["event"]["payload"]["reason"]
    >().toEqualTypeOf<"requested" | "retention">();
    expectTypeOf<CancelledCommand>().toEqualTypeOf<{
      readonly commandId: string;
      readonly type: string;
    }>();
    expectTypeOf<RemovedDeadLetter>().toEqualTypeOf<{
      readonly id: string;
      readonly commandType: string;
    }>();
    expectTypeOf<ProjectForgotten.Args["table"]>().toEqualTypeOf<Table<OrderSummaryRow>>();
    expectTypeOf<
      AuditOnPersonalDataForgotten.HandlerArgs["event"]
    >().toEqualTypeOf<PersonalDataForgottenEvent>();
    expectTypeOf<AuditOnPersonalDataForgotten.HandlerArgs["auditLog"]>().toHaveProperty("record");
  });

  it("reports where sealing what was written before the personal data marks stands", () => {
    expectTypeOf<
      Awaited<ReturnType<BoundaClient["getLag"]>>["personalDataBackfill"]
    >().toEqualTypeOf<PersonalDataBackfillLag | null>();
    expectTypeOf<PersonalDataBackfillLag>().toEqualTypeOf<{
      readonly position: number;
      readonly caughtUp: boolean;
    }>();
  });

  it("names the categories app/personal-data.ts declares, and checks the declaration", () => {
    expectTypeOf<PersonalCategory>().toEqualTypeOf<"delivery" | "invoices">();
    expectTypeOf<PersonalDataDeclaration>().toEqualTypeOf<true>();
    expectTypeOf<PersonalData.Categories>().toEqualTypeOf<PersonalDataCategories>();
    expectTypeOf<PersonalDataCategory>().toEqualTypeOf<{
      readonly basis: LegalBasis;
      readonly retention: RetentionInput;
    }>();
    expectTypeOf<RetentionInput>().toEqualTypeOf<DurationInput | `${number}mo` | `${number}y`>();
    expectTypeOf<LegalBasis>().toEqualTypeOf<
      | "consent"
      | "contract"
      | "legal-obligation"
      | "vital-interests"
      | "public-task"
      | "legitimate-interests"
    >();
    expectTypeOf<Parameters<EventPayloadArgs["personal"]>[1]>().toEqualTypeOf<
      PersonalOptions | undefined
    >();
    expectTypeOf<PersonalOptions>().toEqualTypeOf<{
      readonly category?: "delivery" | "invoices";
    }>();
    expectTypeOf<OrderPlaced.EvolveArgs["event"]["payload"]["note"]>().toEqualTypeOf<
      string | null | undefined
    >();
  });

  it("lets every client forget a person, answering like a command", () => {
    expectTypeOf<BoundaClient["forget"]>().toEqualTypeOf<
      (personId: string, options?: ForgetOptions) => Promise<StoredDispatch>
    >();
    expectTypeOf<ForgetOptions>().toEqualTypeOf<{
      readonly categories?: readonly ("default" | "delivery" | "invoices")[];
    }>();
    expectTypeOf<BoundaApp["forget"]>().toEqualTypeOf<BoundaClient["forget"]>();
  });

  it("lets every client export a person's data, their marked fields alone", () => {
    expectTypeOf<BoundaClient["exportPersonalData"]>().toEqualTypeOf<
      (personId: string) => Promise<PersonalDataExport>
    >();
    expectTypeOf<BoundaApp["exportPersonalData"]>().toEqualTypeOf<
      BoundaClient["exportPersonalData"]
    >();
    expectTypeOf<PersonalDataExport>().toEqualTypeOf<{
      readonly personId: string;
      readonly exportedAt: string;
      readonly categories: Readonly<Record<string, ExportedCategory>>;
      readonly events: readonly ExportedEvent[];
      readonly scheduledCommands: readonly ExportedScheduledCommand[];
      readonly deadLetters: readonly ExportedDeadLetter[];
      readonly subscriberFailures: readonly ExportedSubscriberFailure[];
      readonly readModels: Readonly<Record<string, readonly ExportedRow[]>>;
    }>();
    expectTypeOf<ExportedSubscriberFailure>().toEqualTypeOf<{
      readonly subscriber: string;
      readonly eventId: string;
      readonly eventType: string;
      readonly errorMessage: string | null;
      readonly errorStack?: string | null;
    }>();
    expectTypeOf<ExportedRow>().toEqualTypeOf<{
      readonly key: unknown;
      readonly data: ExportedData;
      readonly categories: ExportedCategories;
    }>();
    expectTypeOf<ExportedEvent>().toEqualTypeOf<{
      readonly id: string;
      readonly type: string;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly version: number;
      readonly position: number;
      readonly timestamp: string;
      readonly data: ExportedData;
      readonly categories: ExportedCategories;
    }>();
    expectTypeOf<ExportedScheduledCommand>().toEqualTypeOf<{
      readonly commandId: string;
      readonly type: string;
      readonly executeAt: string;
      readonly data: ExportedData;
      readonly categories: ExportedCategories;
    }>();
    expectTypeOf<ExportedDeadLetter>().toEqualTypeOf<{
      readonly id: string;
      readonly kind: DeadLetterKind;
      readonly handler: string;
      readonly errorMessage?: string | null;
      readonly errorStack?: string | null;
      readonly data: ExportedData;
      readonly categories: ExportedCategories;
    }>();
    expectTypeOf<ExportedData>().toEqualTypeOf<Readonly<Record<string, unknown>>>();
    expectTypeOf<ExportedCategories>().toEqualTypeOf<Readonly<Record<string, string>>>();
    expectTypeOf<ExportedCategory>().toEqualTypeOf<{
      readonly basis: LegalBasis | null;
      readonly retention: string | null;
      readonly restrictedUntil: string | null;
    }>();
  });

  it("lets every client restrict a person's processing and lift it, answering like a command", () => {
    expectTypeOf<BoundaClient["restrict"]>().toEqualTypeOf<
      (personId: string) => Promise<StoredDispatch>
    >();
    expectTypeOf<BoundaClient["unrestrict"]>().toEqualTypeOf<BoundaClient["restrict"]>();
    expectTypeOf<BoundaApp["restrict"]>().toEqualTypeOf<BoundaClient["restrict"]>();
    expectTypeOf<BoundaApp["unrestrict"]>().toEqualTypeOf<BoundaClient["unrestrict"]>();
  });

  it("types the restriction events for the projections and policies that handle them", () => {
    expectTypeOf<ProjectRestricted.Args["event"]>().toEqualTypeOf<ProcessingRestrictedEvent>();
    expectTypeOf<ProjectRestricted.Args["event"]["type"]>().toEqualTypeOf<"ProcessingRestricted">();
    expectTypeOf<
      ProjectRestricted.Args["event"]["payload"]
    >().toEqualTypeOf<ProcessingRestrictedPayload>();
    expectTypeOf<ProcessingRestrictedPayload>().toEqualTypeOf<{ readonly personId: string }>();
    expectTypeOf<ProjectRestricted.Args["table"]>().toEqualTypeOf<Table<OrderSummaryRow>>();
    expectTypeOf<
      AuditOnProcessingRestrictionLifted.HandlerArgs["event"]
    >().toEqualTypeOf<ProcessingRestrictionLiftedEvent>();
    expectTypeOf<
      AuditOnProcessingRestrictionLifted.HandlerArgs["event"]["type"]
    >().toEqualTypeOf<"ProcessingRestrictionLifted">();
    expectTypeOf<ProcessingRestrictionLiftedPayload>().toEqualTypeOf<{
      readonly personId: string;
    }>();
    expectTypeOf<AuditOnProcessingRestrictionLifted.HandlerArgs["auditLog"]>().toHaveProperty(
      "record",
    );
  });

  it("hands dead letters out with the error named in the clear and its text opened, null once the person is forgotten", () => {
    expectTypeOf<DeadLetter["person"]>().toEqualTypeOf<string | null>();
    expectTypeOf<DeadLetter["errorName"]>().toEqualTypeOf<string>();
    expectTypeOf<DeadLetter["errorCode"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DeadLetter["errorMessage"]>().toEqualTypeOf<string | null>();
    expectTypeOf<DeadLetter["errorStack"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<BoundaClient["deadLetters"]["list"]>().returns.resolves.toEqualTypeOf<
      readonly DeadLetter[]
    >();
    expectTypeOf<
      BoundaClient["deadLetters"]["retry"]
    >().returns.resolves.toEqualTypeOf<DeadLetter>();
  });
});

describe("policies for another aggregate's events", () => {
  it("receive the event of the aggregate their folder names", () => {
    expectTypeOf<GreetOnCustomerRegistered.HandlerArgs["event"]>().toEqualTypeOf<
      StoredEvent<"CustomerRegistered", { email: string | null }>
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
      StoredEvent<"CustomerRegistered", { email: string | null }>
    >();
    expectTypeOf<ReturnType<Correlator>>().toEqualTypeOf<string | null>();
    expectTypeOf<ReturnType<From>>().toEqualTypeOf<ProcessCorrelation>();
    expectTypeOf<keyof OrderPayment.CorrelateArgs["from"]>().toEqualTypeOf<"customer" | "order">();
  });

  it("infer the event of a correlate entry without annotating it", () => {
    const correlate = ({ from }: OrderPayment.CorrelateArgs) => [
      from.customer.CustomerRegistered((event) => {
        expectTypeOf(event.payload).toEqualTypeOf<{ email: string | null }>();
        return null;
      }),
    ];
    expectTypeOf(correlate).returns.toEqualTypeOf<ProcessCorrelation[]>();
  });

  it("type a handler for another aggregate's event against that aggregate", () => {
    expectTypeOf<OnCustomerRegistered.HandlerArgs["event"]>().toEqualTypeOf<
      StoredEvent<"CustomerRegistered", { email: string | null }>
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

  it("process state: personal() reads as possibly null, person() as declared", () => {
    expectTypeOf<OnOrderPaid.HandlerArgs["state"]["contact"]>().toEqualTypeOf<string | null>();
    expectTypeOf<AtNextReminder.DeadlineArgs["state"]["contact"]>().toEqualTypeOf<string | null>();
    expectTypeOf<OnOrderPaid.HandlerArgs["state"]["customerId"]>().toEqualTypeOf<string | null>();
    expectTypeOf<OrderPayment.StateArgs["personal"]>().toEqualTypeOf<PersonalFunction>();
    expectTypeOf<OrderPayment.StateArgs["person"]>().toEqualTypeOf<PersonFunction>();
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
    expectTypeOf<ProjectOrderPaid.Args["client"]>().toEqualTypeOf<
      ReadClient<OrderSummaryRow, unknown>
    >();
  });

  it("type repositoryData from what repository returns", () => {
    expectTypeOf<GetOrder.HandlerArgs["repositoryData"]>().toEqualTypeOf<OrderSummaryRow | null>();
    expectTypeOf<ListUnpaidOrders.HandlerArgs["repositoryData"]>().toEqualTypeOf<
      readonly OrderSummaryRow[]
    >();
    expectTypeOf<GetOrder.RepositoryArgs["orderId"]>().toEqualTypeOf<string>();
  });

  it("hand a query's repository and handler the actor of the client that asked", () => {
    expectTypeOf<GetOrder.HandlerArgs["actor"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<GetOrder.RepositoryArgs["actor"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<CustomerOverview.HandlerArgs["actor"]>().toEqualTypeOf<string | undefined>();
  });

  it("filter a table by value or by the operators of each field's type", () => {
    type FindMany = Parameters<GetOrder.HandlerArgs["table"]["findMany"]>[0];
    expectTypeOf<NonNullable<FindMany>["where"]>().toEqualTypeOf<
      Where<OrderSummaryRow> | undefined
    >();
    expectTypeOf<Where<OrderSummaryRow>["total"]>().toEqualTypeOf<
      number | RangeFilter<number> | undefined
    >();
    expectTypeOf<Where<OrderSummaryRow>["orderId"]>().toEqualTypeOf<
      string | RangeFilter<string> | undefined
    >();
    expectTypeOf<Where<OrderSummaryRow>["paidAt"]>().toEqualTypeOf<
      Date | null | RangeFilter<Date> | undefined
    >();
    interface Flags {
      readonly status: "placed" | "paid";
      readonly active: boolean;
      readonly archived?: boolean;
      readonly tags: readonly string[];
    }
    expectTypeOf<Where<Flags>["status"]>().toEqualTypeOf<
      "placed" | "paid" | RangeFilter<"placed" | "paid"> | undefined
    >();
    expectTypeOf<Where<Flags>["active"]>().toEqualTypeOf<
      boolean | SetFilter<boolean> | undefined
    >();
    expectTypeOf<Where<Flags>["archived"]>().toEqualTypeOf<
      boolean | null | SetFilter<boolean> | undefined
    >();
    expectTypeOf<Where<Flags>["tags"]>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<SetFilter<boolean>>().toEqualTypeOf<{
      readonly ne?: boolean | null | undefined;
      readonly in?: readonly boolean[] | undefined;
    }>();
    expectTypeOf<Parameters<Table<Flags>["update"]>[0]>().toEqualTypeOf<Where<Flags>>();
    expectTypeOf<Parameters<Table<Flags>["delete"]>[0]>().toEqualTypeOf<Where<Flags>>();
    expectTypeOf<Parameters<Table<Flags>["findOne"]>[0]>().toEqualTypeOf<Where<Flags>>();
    expectTypeOf<Parameters<Table<Flags>["count"]>[0]>().toEqualTypeOf<Where<Flags> | undefined>();
  });

  it("type a table from how its view stores each field, not from the values alone", () => {
    expectTypeOf<CustomerDirectoryFieldTypes>().toEqualTypeOf<{
      readonly customerId: "string";
      readonly email: "string";
      readonly tier: "json";
      readonly newsletter: "boolean";
    }>();
    expectTypeOf<OrderSummaryFieldTypes>().toEqualTypeOf<{
      readonly orderId: "string";
      readonly customerId: "string";
      readonly status: "string";
      readonly total: "number";
      readonly paidAt: "date";
    }>();
    type Customers = Table<CustomerDirectoryRow, CustomerDirectoryFieldTypes>;
    expectTypeOf<GetCustomer.RepositoryArgs["table"]>().toEqualTypeOf<Customers>();
    expectTypeOf<GetCustomer.HandlerArgs["table"]>().toEqualTypeOf<Customers>();
    expectTypeOf<ProjectCustomerRegistered.Args["table"]>().toEqualTypeOf<Customers>();
    expectTypeOf<ProjectOrderPaid.Args["table"]>().toEqualTypeOf<
      Table<GeneratedOrderSummaryRow, OrderSummaryFieldTypes>
    >();
    type CustomerWhere = Where<CustomerDirectoryRow, CustomerDirectoryFieldTypes>;
    expectTypeOf<NonNullable<Parameters<Customers["findMany"]>[0]>["where"]>().toEqualTypeOf<
      CustomerWhere | undefined
    >();
    expectTypeOf<CustomerWhere["tier"]>().toEqualTypeOf<"regular" | "vip" | null | undefined>();
    expectTypeOf<CustomerWhere["newsletter"]>().toEqualTypeOf<
      boolean | null | SetFilter<boolean> | undefined
    >();
    expectTypeOf<CustomerWhere["email"]>().toEqualTypeOf<
      string | null | RangeFilter<string> | undefined
    >();
    expectTypeOf<Where<CustomerDirectoryRow>["tier"]>().toEqualTypeOf<
      "regular" | "vip" | null | RangeFilter<"regular" | "vip"> | undefined
    >();
  });

  it("refuse in the types what the runtime refuses: operators on JSON, a range on a boolean", () => {
    const filter = (table: GetCustomer.RepositoryArgs["table"]) => {
      table.findMany({ where: { tier: "vip", newsletter: { ne: false }, email: { gte: "a" } } });
      table.count({ newsletter: { in: [true] }, customerId: { in: ["c-1"] } });
      table.delete({ tier: null });
      // @ts-expect-error a JSON field takes no range, even one whose values are strings
      table.findMany({ where: { tier: { gt: "regular" } } });
      // @ts-expect-error a JSON field takes no membership
      table.count({ tier: { in: ["vip"] } });
      // @ts-expect-error a JSON field takes no inequality
      table.update({ tier: { ne: "vip" } }, { newsletter: true });
      // @ts-expect-error a boolean has no order to range over
      table.findOne({ newsletter: { gt: false } });
      // @ts-expect-error a boolean has no order to range over
      table.delete({ newsletter: { lte: true } });
      // @ts-expect-error an operator the table does not know
      table.findMany({ where: { email: { like: "a%" } } });
    };
    expectTypeOf(filter).toBeFunction();
  });

  it("pick a field's operators by how it is stored, and by its value without a view", () => {
    expectTypeOf<FieldFilter<string, "json">>().toEqualTypeOf<string>();
    expectTypeOf<FieldFilter<number | undefined, "json">>().toEqualTypeOf<
      number | null | undefined
    >();
    expectTypeOf<FieldFilter<boolean, "boolean">>().toEqualTypeOf<boolean | SetFilter<boolean>>();
    expectTypeOf<FieldFilter<Date, "date">>().toEqualTypeOf<Date | RangeFilter<Date>>();
    expectTypeOf<FieldFilter<string>>().toEqualTypeOf<string | RangeFilter<string>>();
    expectTypeOf<FieldFilter<{ a: 1 }>>().toEqualTypeOf<{ a: 1 }>();
    interface Mixed {
      readonly id: string;
      readonly at?: Date;
      readonly on: boolean;
      readonly count: number;
      readonly doc: { readonly a: number };
    }
    expectTypeOf<FieldTypesOfRow<Mixed>>().toEqualTypeOf<{
      readonly id: "string";
      readonly at: "date";
      readonly on: "boolean";
      readonly count: "number";
      readonly doc: "json";
    }>();
    expectTypeOf<Table<Mixed>>().toEqualTypeOf<Table<Mixed, FieldTypesOfRow<Mixed>>>();
    interface Unions {
      readonly key: string | number;
      readonly either: string | { readonly a: number };
    }
    expectTypeOf<FieldTypesOfRow<Unions>>().toEqualTypeOf<{
      readonly key: "string" | "number";
      readonly either: "json";
    }>();
    expectTypeOf<Where<Unions>["key"]>().toEqualTypeOf<
      string | number | RangeFilter<string | number> | undefined
    >();
    expectTypeOf<FieldTypesOfRow<Mixed>>().toExtend<FieldTypes<Mixed>>();
    const view = {
      fields: ({ f }: FieldsArgs) => ({ id: f.string().primaryKey(), doc: f.json<string>() }),
    };
    expectTypeOf<FieldTypesOf<typeof view>>().toEqualTypeOf<{
      readonly id: "string";
      readonly doc: "json";
    }>();
    expectTypeOf<FieldTypesOf<{ fields: string }>>().toBeNever();
  });

  it("let a table typed from its view go where a table typed from its row is expected", () => {
    expectTypeOf<Table<CustomerDirectoryRow, CustomerDirectoryFieldTypes>>().toExtend<
      Table<CustomerDirectoryRow>
    >();
  });

  it("let a query compose other queries through the typed facade", () => {
    expectTypeOf<CustomerOverview.HandlerArgs["queries"]>().toHaveProperty("getOrder");
    expectTypeOf<Queries["customerOverview"]>().returns.toEqualTypeOf<
      Promise<{
        unpaidCount: number;
        outstanding: number;
        outstandingUsd: number;
        lastStatus: string | null;
      }>
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
    expectTypeOf<DispatchOptions["idempotencyKey"]>().toEqualTypeOf<string | undefined>();
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
    expectTypeOf<Consistency>().toEqualTypeOf<"read-your-writes" | "eventual">();
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
      commands.payOrder(payment, { idempotencyKey: "req-1" }),
    ).resolves.toEqualTypeOf<StoredDispatch>();
    expectTypeOf(
      commands.payOrder(payment, { idempotencyKey: "req-1", delay: "1h" }),
    ).resolves.toEqualTypeOf<ScheduledDispatch>();
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
    expectTypeOf<BoundaClient["commands"]>().toEqualTypeOf<Commands>();
    expectTypeOf<BoundaClient["queries"]>().toEqualTypeOf<Queries>();
  });

  it("are what a request sees of the app, wherever it runs", () => {
    expectTypeOf<BoundaApp<Registry>>().toExtend<BoundaClient<Registry>>();
  });

  it("bind a client to who acts with as, which answers a client of the same registry", () => {
    expectTypeOf<BoundaClient["as"]>().toEqualTypeOf<(actor: string) => BoundaClient>();
    expectTypeOf<BoundaApp<Registry>["as"]>().toEqualTypeOf<
      (actor: string) => BoundaClient<Registry>
    >();
    const client = {} as BoundaClient;
    expectTypeOf(client.as("user-1").commands).toEqualTypeOf<Commands>();
    expectTypeOf(client.as("user-1").as("user-2").queries).toEqualTypeOf<Queries>();
    expectTypeOf(MAX_ACTOR_LENGTH).toEqualTypeOf<number>();
    expectTypeOf(checkActor).toEqualTypeOf<CheckActorFunction>();
    // @ts-expect-error an actor is an id, never an object with a name or an email
    void client.as({ id: "user-1", email: "ada@example.com" });
    // @ts-expect-error a bound client has no lifecycle: only the app starts and stops
    void client.as("user-1").stop();
  });

  it("read the global stream by position, every event as it was stored", () => {
    const client = {} as BoundaClient;
    expectTypeOf(client.events.read).parameter(0).toEqualTypeOf<ReadEventsArgs | undefined>();
    expectTypeOf<ReadEventsArgs>().toEqualTypeOf<{
      readonly after?: number;
      readonly limit?: number;
    }>();
    expectTypeOf(client.events.read()).resolves.toEqualTypeOf<readonly StoredEvent[]>();
    expectTypeOf<StoredEvent["payload"]>().toBeUnknown();
    expectTypeOf<StoredEvent["metadata"]>().toEqualTypeOf<EventMetadata>();
    // @ts-expect-error a position is a number
    void client.events.read({ after: "3" });
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

describe("operations", () => {
  it("types the status every client reads, without text, and the scopes of the tables", () => {
    expectTypeOf<BoundaClient["status"]>().toEqualTypeOf<() => Promise<AppStatus>>();
    expectTypeOf<BoundaApp["status"]>().toEqualTypeOf<BoundaClient["status"]>();
    expectTypeOf<AppStatus["schema"]>().toEqualTypeOf<readonly SchemaStatus[]>();
    expectTypeOf<SchemaStatus>().toEqualTypeOf<{
      readonly database: string;
      readonly scope: string;
      readonly version: number;
      readonly latest: number;
    }>();
    expectTypeOf<SchemaVersion>().toEqualTypeOf<{
      readonly scope: string;
      readonly version: number;
      readonly latest: number;
    }>();
    expectTypeOf<SchemaScopeName>().toEqualTypeOf<"storage" | "checkpoints" | "forget-ledger">();
    expectTypeOf<Adapter["schemaVersions"]>().toEqualTypeOf<
      () => Promise<readonly SchemaVersion[]>
    >();
    expectTypeOf<Adapter["migrate"]>().toEqualTypeOf<
      (scopes: readonly SchemaScopeName[]) => Promise<readonly SchemaVersion[]>
    >();
    expectTypeOf<AppStatus["restoresFound"]>().toEqualTypeOf<number>();
    expectTypeOf<AppStatus["keyRotation"]>().toEqualTypeOf<KeyRotationStatus | null>();
    expectTypeOf<AppStatus["retention"]>().toEqualTypeOf<RetentionStatus | null>();
    expectTypeOf<
      AppStatus["deadLetterRetention"]
    >().toEqualTypeOf<DeadLetterRetentionStatus | null>();
    expectTypeOf<
      AppStatus["forgetLedger"]
    >().toEqualTypeOf<ForgetLedgerReconciliationStatus | null>();
    expectTypeOf<
      AppStatus["personalDataBackfill"]
    >().toEqualTypeOf<PersonalDataBackfillLag | null>();
    expectTypeOf<
      "errorMessage" | "errorStack" extends keyof SubscriberFailureStatus ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<SubscriberFailureStatus["current"]>().toEqualTypeOf<boolean>();
    expectTypeOf<KeyRotationStatus>().toEqualTypeOf<{
      readonly kid: string;
      readonly previous: readonly string[];
      readonly pending: number;
      readonly completeAt: string | null;
    }>();
    expectTypeOf<RetentionStatus>().toEqualTypeOf<{
      readonly categories: readonly CategoryRetentionStatus[];
      readonly keptBeyond: number;
    }>();
    expectTypeOf<CategoryRetentionStatus>().toEqualTypeOf<{
      readonly category: string;
      readonly retention: string;
      readonly due: number;
      readonly nextDueAt: string | null;
    }>();
  });

  it("opens a subscriber's last failure only through a recorded call", () => {
    expectTypeOf<BoundaClient["subscriberFailures"]>().toEqualTypeOf<SubscriberFailures>();
    expectTypeOf<SubscriberFailures["list"]>().toEqualTypeOf<
      () => Promise<readonly SubscriberFailure[]>
    >();
    expectTypeOf<SubscriberFailures["get"]>().toEqualTypeOf<
      (subscriber: string) => Promise<SubscriberFailure | null>
    >();
    expectTypeOf<SubscriberFailure["errorMessage"]>().toEqualTypeOf<string | null>();
    expectTypeOf<SubscriberFailure["errorStack"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<StoredSubscriberFailure["person"]>().toEqualTypeOf<string | null>();
    expectTypeOf<SubscriberFailure["resolvedAt"]>().toEqualTypeOf<string | null>();
  });

  it("declares a restore on the app, and keeps the ledger's marks outside the database", () => {
    expectTypeOf<BoundaApp["restored"]>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<ForgetLedger["readMark"]>().toEqualTypeOf<(name: string) => Promise<number>>();
    expectTypeOf<ForgetLedger["raiseMark"]>().toEqualTypeOf<
      (name: string, value: number) => Promise<void>
    >();
  });

  it("names a process given up as abandoned", () => {
    expectTypeOf<ProcessStatus>().toEqualTypeOf<
      "started" | "completed" | "failed" | "timed_out" | "abandoned"
    >();
  });
});
