import type { Projection } from "./+types/order-paid";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update(
    { orderId: event.aggregateId },
    { status: "paid", paidAt: new Date(event.timestamp) },
  );
};
