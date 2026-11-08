import { createTestApp, expectForgotten } from "@bounda-dev/core/testing";
import { describe, expect, it } from "vitest";
import { registry } from "../.bounda/registry.ts";

const orderId = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01";

describe("orders", () => {
  it("places an order and lists it for the customer", async () => {
    const { app } = await createTestApp({ registry });
    await app.commands.placeOrder({ orderId, customerId: "ada", total: 42 });
    await app.runUntilIdle();

    expect(await app.queries.listOrders({ customerId: "ada" })).toEqual({
      orders: [{ orderId, customerId: "ada", total: 42, placedAt: expect.any(Date) }],
      total: 42,
    });
    await expect(
      app.commands.placeOrder({ orderId, customerId: "ada", total: 1 }),
    ).rejects.toMatchObject({ rejected: "AlreadyPlaced" });
    await app.stop();
  });

  it("forgets a customer: their orders stay, what they wrote on them goes", async () => {
    const { app } = await createTestApp({ registry });
    const deliveryNote = "Leave it with the porter";
    await app.commands.placeOrder({ orderId, customerId: "ada", total: 42, deliveryNote });
    await app.runUntilIdle();
    expect((await app.queries.listOrders({ customerId: "ada" })).orders).toMatchObject([
      { deliveryNote },
    ]);

    await app.forget("ada");
    await app.runUntilIdle();
    expect(await app.queries.listOrders({ customerId: "ada" })).toEqual({
      orders: [{ orderId, customerId: "ada", total: 42, placedAt: expect.any(Date) }],
      total: 42,
    });
    // Nothing of hers is left readable anywhere the app stores or logs.
    await expectForgotten(app, "ada");
    await app.stop();
  });
});
