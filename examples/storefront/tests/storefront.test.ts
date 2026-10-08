import { sqlite } from "@bounda-dev/adapter-sqlite";
import { DomainError } from "@bounda-dev/core";
import { createTestApp } from "@bounda-dev/core/testing";
import { describe, expect, it } from "vitest";
import { registry } from "../.bounda/registry.ts";
import type { NotifierArgs } from "../app/domain/order/notifier.ts";
import type { CreateIntentArgs, Gateway, RefundArgs } from "../app/domain/payment/gateway.ts";

const ORDER = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01";
const OTHER = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e02";
const items = [
  { productId: "keyboard", quantity: 1, price: 120 },
  { productId: "cable", quantity: 2, price: 9.5 },
];

interface StartArgs {
  readonly failingIntents?: number;
  readonly failingRefunds?: number;
}

/**
 * Each test gets its own notifier, which records what it was asked to send, and its own gateway,
 * which records every call and honours the idempotency key as Stripe does. A gateway told to fail
 * throws on its first calls, as a provider that cannot be reached.
 */
const start = async ({ failingIntents = 0, failingRefunds = 0 }: StartArgs = {}) => {
  const sent: NotifierArgs[] = [];
  const intentCalls: CreateIntentArgs[] = [];
  const refundCalls: RefundArgs[] = [];
  const intents = new Map<string, CreateIntentArgs>();
  const refunds = new Map<string, RefundArgs>();
  const gateway: Gateway = {
    createIntent: async (intent) => {
      intentCalls.push(intent);
      if (intentCalls.length <= failingIntents) throw new Error("gateway unreachable");
      intents.set(intent.idempotencyKey, intents.get(intent.idempotencyKey) ?? intent);
      return { intentId: `pi_${intent.idempotencyKey}` };
    },
    refund: async (refund) => {
      refundCalls.push(refund);
      if (refundCalls.length <= failingRefunds) throw new Error("gateway unreachable");
      refunds.set(refund.idempotencyKey, refunds.get(refund.idempotencyKey) ?? refund);
      return { refundId: `re_${refund.idempotencyKey}` };
    },
  };
  const test = await createTestApp({
    registry,
    adapter: sqlite({ memory: true }),
    ports: {
      order: { notifier: async (confirmation) => void sent.push(confirmation) },
      payment: { gateway },
    },
  });
  const summary = async (orderId = ORDER) => test.app.queries.getOrderSummary({ orderId });
  /**
   * The payment the provider's webhooks name, as the app would look it up.
   */
  const paymentOf = async (orderId = ORDER) => {
    const paymentId = (await summary(orderId))?.paymentId;
    if (paymentId === undefined) throw new Error(`Order ${orderId} has no payment`);
    return paymentId;
  };
  return { ...test, sent, intentCalls, refundCalls, intents, refunds, summary, paymentOf };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOUR = 3_600_000;

describe("storefront", () => {
  it("requests the payment, and fulfils the order once the payment settles", async () => {
    const { app, sent, intentCalls, intents, refunds, summary, paymentOf } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.runUntilIdle();

    expect(sent).toEqual([
      {
        orderId: ORDER,
        customerId: "ada",
        total: 139,
        idempotencyKey: expect.stringMatching(UUID),
      },
    ]);
    const paymentId = await paymentOf();
    expect(await summary()).toMatchObject({
      status: "placed",
      total: 139,
      itemCount: 2,
      confirmationSent: true,
      reminderSent: false,
      paymentStatus: "pending",
    });
    // The key is the requestPayment command's own, not the payment id.
    expect([...intents.values()]).toEqual([
      { paymentId, orderId: ORDER, amount: 139, idempotencyKey: expect.stringMatching(UUID) },
    ]);
    expect(intentCalls).toHaveLength(1);
    expect(intentCalls[0]?.idempotencyKey).not.toBe(paymentId);

    await app.commands.settlePayment({ paymentId });
    await app.runUntilIdle();
    expect(await summary()).toMatchObject({
      status: "fulfilled",
      paidAt: expect.any(Date),
      fulfilledAt: expect.any(Date),
      paymentStatus: "settled",
    });
    expect(refunds.size).toBe(0);
    expect((await app.getLag()).maxLag).toBe(0);
    await app.stop();
  });

  it("refuses to cancel an order while the provider processes its payment", async () => {
    const { app, clock, summary, paymentOf } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.runUntilIdle();
    await app.commands.markPaymentProcessing({ paymentId: await paymentOf() });
    await app.runUntilIdle();

    expect(await summary()).toMatchObject({ status: "paying", paymentStatus: "processing" });
    await expect(
      app.commands.cancelOrder({ orderId: ORDER, reason: "changed my mind" }),
    ).rejects.toThrow("Payment in progress");

    clock.advance(72 * HOUR);
    await app.runUntilIdle();
    expect((await summary())?.status).toBe("paying");

    await app.commands.settlePayment({ paymentId: await paymentOf() });
    await app.runUntilIdle();
    expect((await summary())?.status).toBe("fulfilled");
    await app.stop();
  });

  it("releases the order and cancels it when the payment is declined", async () => {
    const { app, refundCalls, summary, paymentOf } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.runUntilIdle();
    const paymentId = await paymentOf();
    await app.commands.markPaymentProcessing({ paymentId });
    await app.runUntilIdle();

    await app.commands.declinePayment({ paymentId, reason: "card declined" });
    await app.runUntilIdle();
    expect(await summary()).toMatchObject({
      status: "cancelled",
      cancelledAt: expect.any(Date),
      paymentStatus: "declined",
    });
    expect(refundCalls).toEqual([]);
    await app.stop();
  });

  it("refunds a payment made with the link of an order the customer cancelled", async () => {
    const { app, refunds, summary, paymentOf } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.runUntilIdle();
    await app.commands.cancelOrder({ orderId: ORDER, reason: "changed my mind" });
    await app.runUntilIdle();
    expect(await summary()).toMatchObject({ status: "cancelled", paymentStatus: "cancelled" });

    await app.commands.settlePayment({ paymentId: await paymentOf() });
    await app.runUntilIdle();
    expect(await summary()).toMatchObject({ status: "cancelled", paymentStatus: "refunded" });
    expect([...refunds.values()]).toEqual([
      { intentId: expect.any(String), amount: 139, idempotencyKey: expect.stringMatching(UUID) },
    ]);
    await app.stop();
  });

  it("cancels an order that is not paid in time, and refunds a payment that comes later", async () => {
    const { app, clock, refunds, summary, paymentOf } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.runUntilIdle();

    clock.advance(72 * HOUR);
    await app.runUntilIdle();
    expect(await summary()).toMatchObject({
      status: "cancelled",
      cancelledAt: expect.any(Date),
      paymentStatus: "cancelled",
    });
    expect(await app.queries.getMyOrders({ customerId: "ada" })).toEqual([
      { orderId: ORDER, customerId: "ada", status: "cancelled", total: 139 },
    ]);

    await app.commands.settlePayment({ paymentId: await paymentOf() });
    await app.runUntilIdle();
    expect((await summary())?.paymentStatus).toBe("refunded");
    expect(refunds.size).toBe(1);
    await app.stop();
  });

  it("gives up on an order whose payment never ends, and compensates as for any cancellation", async () => {
    const { app, clock, refunds, summary, paymentOf } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.runUntilIdle();
    await app.commands.markPaymentProcessing({ paymentId: await paymentOf() });
    await app.runUntilIdle();

    clock.advance(30 * 24 * HOUR);
    await app.runUntilIdle();
    expect(await summary()).toMatchObject({
      status: "cancelled",
      cancelledAt: expect.any(Date),
      paymentStatus: "cancelled",
    });

    await app.commands.settlePayment({ paymentId: await paymentOf() });
    await app.runUntilIdle();
    expect((await summary())?.paymentStatus).toBe("refunded");
    expect(refunds.size).toBe(1);
    expect((await app.getLag()).maxLag).toBe(0);
    await app.stop();
  });

  it("settles a payment once however many times the provider says it succeeded", async () => {
    const { app, refundCalls, summary, paymentOf } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.runUntilIdle();
    const paymentId = await paymentOf();

    const settle = async () => (await app.commands.settlePayment({ paymentId })).eventTypes;
    expect(await settle()).toEqual(["PaymentSettled"]);
    expect(await settle()).toEqual([]);
    await app.runUntilIdle();
    expect(await settle()).toEqual([]);
    await app.runUntilIdle();
    expect(await summary()).toMatchObject({ status: "fulfilled", paymentStatus: "settled" });
    expect(refundCalls).toEqual([]);
    await app.stop();
  });

  it("retries a refund that fails with the same key, and refunds once", async () => {
    const { app, refundCalls, refunds, summary, paymentOf } = await start({
      failingRefunds: 1,
    });
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.runUntilIdle();
    await app.commands.cancelOrder({ orderId: ORDER, reason: "changed my mind" });
    await app.runUntilIdle();
    await app.commands.settlePayment({ paymentId: await paymentOf() });
    await app.runUntilIdle();
    expect(refundCalls).toHaveLength(2);
    expect(refundCalls[1]?.idempotencyKey).toBe(refundCalls[0]?.idempotencyKey);
    expect(refunds.size).toBe(1);
    expect((await summary())?.paymentStatus).toBe("refunded");
    await app.stop();
  });

  it("compensates a payment that settles while the order is being cancelled", async () => {
    const { app, refunds, summary, paymentOf } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.runUntilIdle();

    await app.commands.settlePayment({ paymentId: await paymentOf() });
    await app.commands.cancelOrder({ orderId: ORDER, reason: "changed my mind" });
    const { rejections } = await app.runUntilIdle();
    expect(rejections).toMatchObject([{ type: "MarkOrderPaid", rejected: "NotOpen" }]);
    expect(await summary()).toMatchObject({ status: "cancelled", paymentStatus: "refunded" });
    expect(refunds.size).toBe(1);
    expect((await app.getLag()).maxLag).toBe(0);
    await app.stop();
  });

  it("reminds the customer a day later only while the order waits for the payment", async () => {
    const { app, clock, summary, paymentOf } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.commands.placeOrder({
      orderId: OTHER,
      customerId: "ada",
      items: [items[0] as (typeof items)[number]],
    });
    await app.runUntilIdle();
    await expect(app.commands.fulfillOrder({ orderId: ORDER })).rejects.toThrow(
      "Only paid orders can be fulfilled; this one is placed",
    );
    await app.commands.markPaymentProcessing({ paymentId: await paymentOf(OTHER) });
    await app.runUntilIdle();

    clock.advance(24 * HOUR);
    await app.runUntilIdle();
    expect((await summary())?.reminderSent).toBe(true);
    expect((await summary(OTHER))?.reminderSent).toBe(false);
    await app.stop();
  });

  it("takes the provider's webhooks in whatever order they arrive", async () => {
    const { app, refunds, summary, paymentOf } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.commands.placeOrder({ orderId: OTHER, customerId: "ada", items });
    await app.runUntilIdle();

    const settledFirst = await paymentOf();
    await app.commands.settlePayment({ paymentId: settledFirst });
    await app.commands.markPaymentProcessing({ paymentId: settledFirst });
    await app.runUntilIdle();
    expect(await summary()).toMatchObject({ status: "fulfilled", paymentStatus: "settled" });

    const declinedFirst = await paymentOf(OTHER);
    await app.commands.declinePayment({ paymentId: declinedFirst, reason: "card declined" });
    await app.runUntilIdle();
    await app.commands.settlePayment({ paymentId: declinedFirst });
    await app.runUntilIdle();
    expect(await summary(OTHER)).toMatchObject({ status: "cancelled", paymentStatus: "refunded" });
    expect(refunds.size).toBe(1);
    await app.stop();
  });

  it("requests the same payment again when creating the intent fails", async () => {
    const { app, intentCalls, intents, paymentOf } = await start({
      failingIntents: 1,
    });
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.runUntilIdle();
    const paymentId = await paymentOf();
    expect(intentCalls.map((call) => call.paymentId)).toEqual([paymentId, paymentId]);
    expect(intentCalls[1]?.idempotencyKey).toBe(intentCalls[0]?.idempotencyKey);
    expect(intents.size).toBe(1);
    await app.stop();
  });

  it("enforces the order rules", async () => {
    const { app } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await expect(
      app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items }),
    ).rejects.toMatchObject({ rejected: "AlreadyPlaced" });
    await app.commands.markOrderPaid({ orderId: ORDER });
    expect((await app.commands.markOrderPaid({ orderId: ORDER })).eventTypes).toEqual([]);
    await app.commands.placeOrder({ orderId: OTHER, customerId: "ada", items });
    await app.commands.cancelOrder({ orderId: OTHER, reason: "changed my mind" });
    await expect(app.commands.markOrderPaid({ orderId: OTHER })).rejects.toThrow(
      "Only open orders can be paid; this one is cancelled",
    );
    const unknownPayment = app.commands.settlePayment({
      paymentId: "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e09",
    });
    await expect(unknownPayment).rejects.toBeInstanceOf(DomainError);
    await expect(unknownPayment).rejects.toMatchObject({ rejected: "NeverRequested" });
    await expect(
      app.commands.placeOrder({
        orderId: "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e03",
        customerId: "ada",
        items: [],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await app.stop();
  });

  it("answers a customer overview from hand-written SQL", async () => {
    const { app, paymentOf } = await start();
    await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
    await app.commands.placeOrder({
      orderId: OTHER,
      customerId: "ada",
      items: [items[0] as (typeof items)[number]],
    });
    await app.runUntilIdle();
    await app.commands.settlePayment({ paymentId: await paymentOf() });
    await app.runUntilIdle();

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
