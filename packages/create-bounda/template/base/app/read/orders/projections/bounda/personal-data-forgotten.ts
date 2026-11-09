import type { Projection } from "./+types/personal-data-forgotten";

// The orders stay, as the business's record; what the customer wrote on them goes.
export const project = async ({ event, table }: Projection.Args) => {
  for (const order of await table.findMany({ where: { customerId: event.payload.personId } })) {
    await table.upsert({
      orderId: order.orderId,
      customerId: order.customerId,
      total: order.total,
      placedAt: order.placedAt,
    });
  }
};
