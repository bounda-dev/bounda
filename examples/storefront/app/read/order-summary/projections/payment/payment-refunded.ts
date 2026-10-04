import type { Projection } from "./+types/payment-refunded";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update({ orderId: event.payload.orderId }, { paymentStatus: "refunded" });
};
