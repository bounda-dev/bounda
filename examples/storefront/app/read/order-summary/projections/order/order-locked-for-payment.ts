import type { Projection } from "./+types/order-locked-for-payment";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update({ orderId: event.aggregateId }, { status: "paying" });
};
