import type { Projection } from "./+types/processing-restricted";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update({ customerId: event.payload.personId }, { status: "on-hold" });
};
