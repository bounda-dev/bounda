import type { Projection } from "./+types/customer-registered";

export const project = async ({ event, table }: Projection.Args) => {
  await table.upsert({
    customerId: event.aggregateId,
    ...(event.payload.email === null ? {} : { email: event.payload.email }),
  });
};
