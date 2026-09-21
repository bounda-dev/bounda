import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { boot } from "@bounda-dev/core/node";
import type { registry } from "../.bounda/registry.ts";

await mkdir("./data", { recursive: true });
const app = await boot<typeof registry>({ signals: false });

await app.commands.placeOrder({ orderId: randomUUID(), customerId: "ada", total: 42 });
await app.processUntilIdle();

const { orders, total } = await app.queries.listOrders({ customerId: "ada" });
console.log(`${orders.length} order(s) for ada, ${total} in total`);

await app.stop();
