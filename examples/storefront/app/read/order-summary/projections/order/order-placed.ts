import type { Projection } from "./+types/order-placed";

export const project = async ({ event, table }: Projection.Args) => {
  await table.upsert({
    orderId: event.aggregateId,
    customerId: event.payload.customerId,
    status: "placed",
    total: event.payload.total,
    itemCount: event.payload.items.length,
    placedAt: new Date(event.timestamp),
    confirmationSent: false,
    reminderSent: false,
  });
};
