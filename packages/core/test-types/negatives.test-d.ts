import {
  DomainError,
  type ImplementationModule,
  type Instant,
  type PolicyModule,
  type ProcessDeadlineField,
  type ProcessHandlerReturnCheck,
  type ProcessStateOf,
} from "@bounda-dev/core";
import type { AdapterDefinition } from "@bounda-dev/core/adapter";
import { defineConfig } from "@bounda-dev/core/config";
import { describe, it } from "vitest";
import type { Command as RegisterCustomer } from "./fixtures/order-app/app/domain/customer/commands/+types/register-customer.ts";
import type { Command as PayOrder } from "./fixtures/order-app/app/domain/order/commands/+types/pay-order.ts";
import type { Command as PlaceOrder } from "./fixtures/order-app/app/domain/order/commands/+types/place-order.ts";
import type { Implementation as InventoryFake } from "./fixtures/order-app/app/domain/order/inventory/+types/fake.ts";
import type { Process as AtNextReminder } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/at-next-reminder.ts";
import type { Process as OrderPayment } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/index.ts";
import type { Process as OnOrderPaid } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/on-order-paid.ts";

import type { Projection as ProjectOrderPlaced } from "./fixtures/order-app/app/read/order-summary/projections/order/+types/order-placed.ts";

type OrderPaymentModule =
  typeof import("./fixtures/order-app/app/domain/order/processes/order-payment/index.ts");

declare const sqlite: AdapterDefinition<"sqlite", { path: string }>;

describe("what does not compile", () => {
  it("an at- handler for a field that is not a deadline() of the state", () => {
    // @ts-expect-error paidAt is an instant(), which only records a moment
    type RecordedMoment = ProcessDeadlineField<OrderPaymentModule, "paidAt">;
    // @ts-expect-error reminders is not a moment at all
    type Counter = ProcessDeadlineField<OrderPaymentModule, "reminders">;
    // @ts-expect-error the state has no such field
    type Typo = ProcessDeadlineField<OrderPaymentModule, "nextRemindr">;
    const fields: [RecordedMoment?, Counter?, Typo?] = [];
    void fields;
  });

  it("a rejection the command does not declare", () => {
    const handler = ({ reject }: PayOrder.HandlerArgs) => {
      // @ts-expect-error pay-order declares NotPlaced only
      return reject("Typo");
    };
    void handler;
    const policy = async ({ commands }: OnOrderPaid.HandlerArgs) => {
      const paid = await commands.payOrder({ orderId: "o-1", method: "card", reference: "r" });
      // @ts-expect-error pay-order never rejects with Typo
      if (paid.rejected === "Typo") return;
      const cancelled = await commands.cancelOrder({ orderId: "o-1", reason: "r" });
      // @ts-expect-error cancel-order declares no rejections
      if (cancelled.rejected === "NotPlaced") return;
    };
    void policy;
  });

  it("a DomainError built by hand", () => {
    // @ts-expect-error only reject() makes the Rejection a DomainError takes
    const error = new DomainError({ code: "NotPlaced", message: "no" });
    void error;
  });

  it("a delay after() cannot read", () => {
    const handler = ({ state, after }: OnOrderPaid.HandlerArgs) => ({
      ...state,
      // @ts-expect-error "24x" has no unit after() knows
      nextReminder: after("24x"),
    });
    void handler;
  });

  it("a handler that returns a state its process refuses", () => {
    type State = ProcessStateOf<OrderPaymentModule>;
    type Returning<Result> = { handler: () => Result };
    type Accepted = [
      ProcessHandlerReturnCheck<State, Returning<{ reminders: number }>>,
      ProcessHandlerReturnCheck<State, Returning<Promise<State>>>,
      ProcessHandlerReturnCheck<State, Returning<undefined>>,
      ProcessHandlerReturnCheck<State, Returning<{ nextReminder: Instant | null }>>,
      ProcessHandlerReturnCheck<
        State,
        Returning<Promise<{ reminders: number } | { paidAt: null } | undefined>>
      >,
      ProcessHandlerReturnCheck<State, Returning<void>>,
    ];
    type Plain = Returning<{ nextReminder: string }>;
    type Wrong = Returning<{ reminders: "1" }>;
    type Other = Returning<Promise<string>>;
    // @ts-expect-error a deadline takes an Instant from after() or asInstant, not a plain string
    type PlainString = ProcessHandlerReturnCheck<State, Plain>;
    // @ts-expect-error reminders is a number
    type WrongField = ProcessHandlerReturnCheck<State, Wrong>;
    // @ts-expect-error a handler returns the next state, not anything else
    type NotAState = ProcessHandlerReturnCheck<State, Other>;
    type Misspelt = Returning<{ reminders: number; remindrs: number }>;
    type MisspeltInABranch = Returning<
      Promise<{ reminders: number } | { paidAt: null; remindrs: number } | undefined>
    >;
    // @ts-expect-error remindrs is not a field of the state, so the schema would drop it
    type Typo = ProcessHandlerReturnCheck<State, Misspelt>;
    // @ts-expect-error in any branch of what it returns
    type TypoInABranch = ProcessHandlerReturnCheck<State, MisspeltInABranch>;
    const checks: [Accepted?, PlainString?, WrongField?, NotAState?, Typo?, TypoInABranch?] = [];
    void checks;
  });

  it("an at- handler that leaves out its deadline", () => {
    type State = ProcessStateOf<OrderPaymentModule>;
    type Field = ProcessDeadlineField<OrderPaymentModule, "nextReminder">;
    type Returning<Result> = { handler: () => Result };
    type Accepted = [
      ProcessHandlerReturnCheck<State, Returning<{ nextReminder: null }>, Field>,
      ProcessHandlerReturnCheck<
        State,
        Returning<Promise<{ reminders: number; nextReminder: Instant }>>,
        Field
      >,
    ];
    // @ts-expect-error left out, the deadline would stay at the moment that came due
    type LeftOut = ProcessHandlerReturnCheck<State, Returning<{ reminders: number }>, Field>;
    // @ts-expect-error nothing keeps the deadline at the moment that came due too
    type Nothing = ProcessHandlerReturnCheck<State, Returning<Promise<undefined>>, Field>;
    type Misspelt = Returning<{ nextReminder: null; remindrs: number }>;
    // @ts-expect-error remindrs is not a field of the state
    type Typo = ProcessHandlerReturnCheck<State, Misspelt, Field>;
    const checks: [Accepted?, LeftOut?, Nothing?, Typo?] = [];
    void checks;
  });

  it("a field returned by a process without state", () => {
    type State = ProcessStateOf<{ readonly config: () => { readonly startedBy: [] } }>;
    type Returning<Result> = { handler: () => Result };
    type Accepted = [
      ProcessHandlerReturnCheck<State, Returning<undefined>>,
      ProcessHandlerReturnCheck<State, Returning<Promise<void>>>,
      ProcessHandlerReturnCheck<State, Returning<Record<never, never>>>,
    ];
    type Seen = Returning<{ seen: true }>;
    // @ts-expect-error a process without state has no field to set
    type Field = ProcessHandlerReturnCheck<State, Seen>;
    const checks: [Accepted?, Field?] = [];
    void checks;
  });

  it("a plain string where an Instant is expected", () => {
    // @ts-expect-error a plain string is not an Instant
    const moment: Instant = "2026-01-01T00:00:00.000Z";
    const handler = ({ state }: AtNextReminder.DeadlineArgs) => ({
      ...state,
      nextReminder: moment,
    });
    void handler;
  });

  it("emitting an event of another aggregate", () => {
    const handler = ({ events }: PlaceOrder.HandlerArgs) => [
      // @ts-expect-error customerRegistered belongs to the customer aggregate
      events.customerRegistered({ email: "a@b.c" }),
    ];
    void handler;
  });

  it("building an event with the wrong payload", () => {
    const handler = ({ events }: PayOrder.HandlerArgs) => [
      // @ts-expect-error method must be "card" | "transfer"
      events.orderPaid({ method: "cash", reference: "x" }),
    ];
    void handler;
  });

  it("using a collaborator of another aggregate", () => {
    // @ts-expect-error inventory belongs to order, not to customer
    const handler = ({ inventory }: RegisterCustomer.HandlerArgs) => inventory;
    void handler;
  });

  it("an implementation that does not fulfil its port's contract", () => {
    // @ts-expect-error reserve is missing
    const wrongShape = { default: {} } satisfies ImplementationModule<InventoryFake.Contract>;
    const wrongSignature = {
      // @ts-expect-error reserve takes the skus, not a number
      default: { reserve: async (count: number) => count },
    } satisfies ImplementationModule<InventoryFake.Contract>;
    const namedExport = {
      // @ts-expect-error an implementation module exports the port as default
      reserve: async () => {},
    } satisfies ImplementationModule<InventoryFake.Contract>;
    void [wrongShape, wrongSignature, namedExport];
  });

  it("an implementation module with both a default export and a create, or a create that builds the wrong port", () => {
    const both = {
      default: { reserve: async () => {} },
      create: () => ({ reserve: async () => {} }),
      // @ts-expect-error an implementation exports default or create, never both
    } satisfies ImplementationModule<InventoryFake.Contract>;
    const wrongPort = {
      // @ts-expect-error create must build an Inventory
      create: () => ({ reserve: async (count: number) => count }),
    } satisfies ImplementationModule<InventoryFake.Contract>;
    void [both, wrongPort];
  });

  it("a collaborators configuration that leaves a choice open or names what does not exist", () => {
    // @ts-expect-error inventory has two implementations, so the config must choose one
    defineConfig({ storage: sqlite });
    // @ts-expect-error inventory has two implementations, so the config must choose one
    defineConfig({ storage: sqlite, collaborators: { order: {} } });
    // @ts-expect-error "fak" is not an implementation of inventory
    defineConfig({ storage: sqlite, collaborators: { order: { inventory: "fak" } } });
    defineConfig({
      storage: sqlite,
      // @ts-expect-error notifier is not a collaborator of order
      collaborators: { order: { inventory: "fake", notifier: "x" } },
    });
    defineConfig({
      storage: sqlite,
      // @ts-expect-error customer has no collaborators
      collaborators: { order: { inventory: "fake" }, customer: {} },
    });
    const fromEnvironment: string = "fake";
    // @ts-expect-error a plain string is not one of the implementation names
    defineConfig({ storage: sqlite, collaborators: { order: { inventory: fromEnvironment } } });
  });

  it("an unqualified event name in a process config", () => {
    const config = ({ events }: OrderPayment.ConfigArgs) => ({
      // @ts-expect-error events are grouped by aggregate: events.order.OrderPlaced
      startedBy: [events.OrderPlaced],
    });
    void config;
  });

  it("correlating an event the aggregate does not have", () => {
    const correlate = ({ from }: OrderPayment.CorrelateArgs) => [
      // @ts-expect-error CustomerDeleted is not an event of customer
      from.customer.CustomerDeleted(() => null),
    ];
    void correlate;
  });

  it("a correlate that returns no instance id", () => {
    const correlate = ({ from }: OrderPayment.CorrelateArgs) => [
      // @ts-expect-error an instance id is a string, or null for none
      from.customer.CustomerRegistered(() => 42),
    ];
    void correlate;
  });

  it("a delay that is not a duration", () => {
    const policy: PolicyModule = {
      handler: () => undefined,
      // @ts-expect-error "10 minutes" is not a duration string
      delay: "10 minutes",
    };
    void policy;
  });

  it("a typo in a process event name", () => {
    const config = ({ events }: OrderPayment.ConfigArgs) => ({
      // @ts-expect-error OrderPlacd is not an event of the aggregate
      startedBy: [events.order.OrderPlacd],
    });
    void config;
  });

  it("writing a column the read model does not have", () => {
    const project = async ({ table }: ProjectOrderPlaced.Args) => {
      await table.upsert({
        orderId: "1",
        customerId: "c",
        status: "placed",
        total: 1,
        // @ts-expect-error discount is not a column of order-summary
        discount: 2,
      });
    };
    void project;
  });

  it("omitting a required column", () => {
    const project = async ({ table }: ProjectOrderPlaced.Args) => {
      // @ts-expect-error total is required
      await table.upsert({ orderId: "1", customerId: "c", status: "placed" });
    };
    void project;
  });
});
