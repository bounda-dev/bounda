import type { Projection } from "./+types/profile-updated";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update({ userId: event.aggregateId }, { name: event.payload.name });
};
