import { randomUUID } from "node:crypto";
import { boot } from "@bounda-dev/core/node";

const app = await boot({ signals: false });

const fulfilled = randomUUID();
const abandoned = randomUUID();

await app.commands.placeOrder({
  orderId: fulfilled,
  customerId: "ada",
  items: [
    { productId: "keyboard", quantity: 1, price: 120 },
    { productId: "cable", quantity: 2, price: 9.5 },
  ],
});
await app.commands.placeOrder({
  orderId: abandoned,
  customerId: "ada",
  items: [{ productId: "monitor", quantity: 1, price: 380 }],
});
await app.processUntilIdle();

await app.commands.confirmOrder({ orderId: fulfilled });
await app.processUntilIdle();

await app.commands.cancelOrder({ orderId: abandoned, reason: "changed my mind" });
await app.processUntilIdle();

const summary = await app.queries.listOrdersByCustomer({ customerId: "ada" });
for (const order of summary.orders) {
  console.log(`${order.orderId}  ${order.status.padEnd(9)}  ${order.total.toFixed(2)}`);
}
console.log(`open: ${summary.open.length}, spent: ${summary.spent.toFixed(2)}`);
console.log(`lag: ${(await app.getLag()).maxLag}`);

await app.stop();
