import type { Projection } from "./+types/order-placed";

export const project = async ({ event, table }: Projection.Args) => {
  await table.insert({
    orderId: event.aggregateId,
    customerId: event.payload.customerId,
    status: "placed",
    total: event.payload.total,
  });
};
