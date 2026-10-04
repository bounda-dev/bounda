import { randomUUID } from "node:crypto";
import { boot } from "@bounda-dev/core/node";

const app = await boot({ signals: false });

const paid = randomUUID();
const declined = randomUUID();
const cancelled = randomUUID();

await app.commands.placeOrder({
  orderId: paid,
  customerId: "ada",
  items: [
    { productId: "keyboard", quantity: 1, price: 120 },
    { productId: "cable", quantity: 2, price: 9.5 },
  ],
});
await app.commands.placeOrder({
  orderId: declined,
  customerId: "ada",
  items: [{ productId: "monitor", quantity: 1, price: 380 }],
});
await app.commands.placeOrder({
  orderId: cancelled,
  customerId: "ada",
  items: [{ productId: "lamp", quantity: 1, price: 42 }],
});
await app.runUntilIdle();

// The provider's webhooks name the payment, which the order summary keeps.
const paymentOf = async (orderId: string) => {
  const paymentId = (await app.queries.getOrderSummary({ orderId }))?.paymentId;
  if (paymentId === undefined) throw new Error(`Order ${orderId} has no payment`);
  return paymentId;
};

await app.commands.markPaymentProcessing({ paymentId: await paymentOf(paid) });
await app.commands.settlePayment({ paymentId: await paymentOf(paid) });
await app.commands.declinePayment({
  paymentId: await paymentOf(declined),
  reason: "card declined",
});
await app.commands.cancelOrder({ orderId: cancelled, reason: "changed my mind" });
await app.runUntilIdle();

// The customer pays the cancelled order with the link they still had: the payment goes back.
await app.commands.settlePayment({ paymentId: await paymentOf(cancelled) });
await app.runUntilIdle();

const summary = await app.queries.listOrdersByCustomer({ customerId: "ada" });
for (const order of summary.orders) {
  console.log(
    `${order.orderId}  ${order.status.padEnd(9)}  ${order.total.toFixed(2).padStart(7)}  payment ${order.paymentStatus}`,
  );
}
console.log(`open: ${summary.open.length}, spent: ${summary.spent.toFixed(2)}`);
console.log(`lag: ${(await app.getLag()).maxLag}`);

await app.stop();
