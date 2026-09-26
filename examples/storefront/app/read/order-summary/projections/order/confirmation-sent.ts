import type { Projection } from "./+types/confirmation-sent";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update({ orderId: event.aggregateId }, { confirmationSent: true });
};
