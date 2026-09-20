import type { Projection } from "./+types/order-cancelled";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update(
    { orderId: event.aggregateId },
    { status: "cancelled", cancelledAt: new Date(event.timestamp) },
  );
};
