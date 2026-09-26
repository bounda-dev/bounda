import { sqlite } from "@bounda-dev/adapter-sqlite";
import { DomainError } from "@bounda-dev/core";
import { createTestApp } from "@bounda-dev/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { registry } from "../.bounda/registry.ts";
import { sent } from "../app/domain/order/policies/send-confirmation-on-order-placed/notifier.memory.ts";

const ORDER = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01";
const OTHER = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e02";
const items = [
  { productId: "keyboard", quantity: 1, price: 120 },
  { productId: "cable", quantity: 2, price: 9.5 },
];

const start = () =>
  createTestApp({
    registry,
    adapter: sqlite({ memory: true }),
    config: {
      policies: { order: { sendConfirmationOnOrderPlaced: { notifier: { use: "memory" } } } },
    },
  });

const HOUR = 3_600_000;

describe("storefront", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("places an order, confirms it to the customer and auto-fulfils it once confirmed", async () => {
    const { app } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.processUntilIdle();

    expect(sent).toEqual([{ orderId: ORDER, customerId: "ada", total: 139 }]);
    expect(await app.queries.getOrderSummary({ orderId: ORDER })).toMatchObject({
      status: "placed",
      total: 139,
      itemCount: 2,
      confirmationSent: true,
      reminderSent: false,
    });

    await app.commands.confirmOrder({ orderId: ORDER });
    await app.processUntilIdle();
    expect(await app.queries.getOrderSummary({ orderId: ORDER })).toMatchObject({
      status: "fulfilled",
      confirmedAt: expect.any(Date),
      fulfilledAt: expect.any(Date),
    });
    expect((await app.getLag()).maxLag).toBe(0);
    await app.stop();
  });

  it("reminds the customer a day later only while the order is still placed", async () => {
    const { app, clock } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.commands.placeOrder({
      orderId: OTHER,
      customerId: "ada",
      items: [items[0] as (typeof items)[number]],
    });
    await app.processUntilIdle();
    await app.commands.confirmOrder({ orderId: OTHER });
    await app.processUntilIdle();

    clock.advance(24 * HOUR);
    await app.processUntilIdle();
    expect((await app.queries.getOrderSummary({ orderId: ORDER }))?.reminderSent).toBe(true);
    expect((await app.queries.getOrderSummary({ orderId: OTHER }))?.reminderSent).toBe(false);
    await app.stop();
  });

  it("cancels an order that is not fulfilled within the process time-out", async () => {
    const { app, clock } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.processUntilIdle();

    clock.advance(72 * HOUR);
    await app.processUntilIdle();
    expect(await app.queries.getOrderSummary({ orderId: ORDER })).toMatchObject({
      status: "cancelled",
      cancelledAt: expect.any(Date),
    });
    expect(await app.queries.getMyOrders({ customerId: "ada" })).toEqual([
      { orderId: ORDER, customerId: "ada", status: "cancelled", total: 139 },
    ]);
    await app.stop();
  });

  it("enforces the order rules", async () => {
    const { app } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await expect(
      app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(app.commands.fulfillOrder({ orderId: ORDER })).rejects.toThrow(
      "Only confirmed orders can be fulfilled; this one is placed",
    );
    await app.commands.confirmOrder({ orderId: ORDER });
    await expect(app.commands.confirmOrder({ orderId: ORDER })).rejects.toThrow(
      "Only placed orders can be confirmed; this one is confirmed",
    );
    await expect(
      app.commands.placeOrder({ orderId: OTHER, customerId: "ada", items: [] }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await app.stop();
  });

  it("answers a customer overview from hand-written SQL", async () => {
    const { app } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.commands.placeOrder({
      orderId: OTHER,
      customerId: "ada",
      items: [items[0] as (typeof items)[number]],
    });
    await app.processUntilIdle();
    await app.commands.confirmOrder({ orderId: ORDER });
    await app.processUntilIdle();

    const overview = await app.queries.listOrdersByCustomer({ customerId: "ada" });
    expect(overview.orders.map((order) => [order.orderId, order.status])).toEqual([
      [ORDER, "fulfilled"],
      [OTHER, "placed"],
    ]);
    expect(overview.open.map((order) => order.orderId)).toEqual([OTHER]);
    expect(overview.spent).toBe(139);
    expect(overview.orders[0]?.placedAt).toBeInstanceOf(Date);
    await app.stop();
  });
});
