import type { Projection } from "./+types/order-payment-failed";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update({ orderId: event.aggregateId }, { status: "placed" });
};
