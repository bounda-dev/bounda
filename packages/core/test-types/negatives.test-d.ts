import { describe, it } from "vitest";
import type { Command as PayOrder } from "./fixtures/order-app/app/domain/order/commands/+types/pay-order.ts";
import type { Command as PlaceOrder } from "./fixtures/order-app/app/domain/order/commands/place-order/+types/index.ts";
import type { Policy as SendReceipt } from "./fixtures/order-app/app/domain/order/policies/+types/send-receipt-on-order-paid.ts";
import type { Process as OrderPayment } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/index.ts";
import type { Projection as ProjectOrderPlaced } from "./fixtures/order-app/app/read/order-summary/projections/+types/order-placed.ts";

describe("what does not compile", () => {
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

  it("a typo in a process event name", () => {
    const config = ({ events }: OrderPayment.ConfigArgs) => ({
      // @ts-expect-error OrderPlacd is not an event of the aggregate
      startedBy: [events.OrderPlacd],
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
