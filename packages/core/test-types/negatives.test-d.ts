import type { Instant, PolicyModule, ProcessDeadlineField } from "@bounda-dev/core";
import { describe, it } from "vitest";
import type { Command as PayOrder } from "./fixtures/order-app/app/domain/order/commands/+types/pay-order.ts";
import type { Command as PlaceOrder } from "./fixtures/order-app/app/domain/order/commands/place-order/+types/index.ts";
import type { Policy as SendReceipt } from "./fixtures/order-app/app/domain/order/policies/+types/send-receipt-on-order-paid.ts";
import type { Process as AtNextReminder } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/at-next-reminder.ts";
import type { Process as OrderPayment } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/index.ts";
import type { Process as OnOrderPaid } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/on-order-paid.ts";

type OrderPaymentModule =
  typeof import("./fixtures/order-app/app/domain/order/processes/order-payment/index.ts");

import type { Projection as ProjectOrderPlaced } from "./fixtures/order-app/app/read/order-summary/projections/order/+types/order-placed.ts";

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

  it("a delay after() cannot read", () => {
    const handler = ({ state, after }: OnOrderPaid.HandlerArgs) => ({
      ...state,
      // @ts-expect-error "24x" has no unit after() knows
      nextReminder: after("24x"),
    });
    void handler;
  });

  it("a moment that did not come from after() or asInstant", () => {
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

  it("using a collaborator the command does not declare", () => {
    // @ts-expect-error inventory is not a collaborator of payOrder
    const handler = ({ inventory }: PayOrder.HandlerArgs) => inventory;
    void handler;
  });

  it("using a collaborator the policy does not have", () => {
    // @ts-expect-error mailer belongs to notifyOnOrderPlaced, not to sendReceiptOnOrderPaid
    const handler = ({ mailer }: SendReceipt.HandlerArgs) => mailer;
    void handler;
  });

  it("an unqualified event name in a process config", () => {
    const config = ({ events }: OrderPayment.ConfigArgs) => ({
      // @ts-expect-error events are grouped by aggregate: events.order.OrderPlaced
      startedBy: [events.OrderPlaced],
    });
    void config;
  });

  it("correlating an event the aggregate does not have", () => {
    const correlate: OrderPayment.Correlate = {
      // @ts-expect-error CustomerDeleted is not an event of customer
      customer: { CustomerDeleted: () => null },
    };
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
