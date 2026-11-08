import type { Projection } from "./+types/order-placed";

export const project = async ({ event, table }: Projection.Args) => {
  const { customerId, total, deliveryNote } = event.payload;
  await table.upsert({
    orderId: event.aggregateId,
    customerId,
    total,
    placedAt: new Date(event.timestamp),
    ...(deliveryNote == null ? {} : { deliveryNote }),
  });
};
