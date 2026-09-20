import type { Projection } from "./+types/order-confirmed";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update(
    { orderId: event.aggregateId },
    { status: "confirmed", confirmedAt: new Date(event.timestamp) },
  );
};
