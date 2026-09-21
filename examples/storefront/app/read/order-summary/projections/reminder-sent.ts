import type { Projection } from "./+types/reminder-sent";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update({ orderId: event.aggregateId }, { reminderSent: true });
};
