import type { Projection } from "./+types/payment-requested";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update(
    { orderId: event.payload.orderId },
    { paymentId: event.aggregateId, paymentStatus: "pending" },
  );
};
