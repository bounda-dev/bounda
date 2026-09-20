import type { Projection } from "./+types/order-fulfilled";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update(
    { orderId: event.aggregateId },
    { status: "fulfilled", fulfilledAt: new Date(event.timestamp) },
  );
};
