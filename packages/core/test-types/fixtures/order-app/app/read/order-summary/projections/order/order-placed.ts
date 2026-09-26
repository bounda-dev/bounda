import type { Projection } from "./+types/order-placed";

export const project = async ({ event, table }: Projection.Args) => {
  await table.upsert({
    orderId: event.aggregateId,
    customerId: event.payload.customerId,
    status: "placed",
    total: event.payload.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
  });
};
