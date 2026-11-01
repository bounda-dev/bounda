import type { Projection } from "./+types/profile-updated";

export const project = async ({ event, table }: Projection.Args) => {
  const { name } = event.payload;
  if (name === null) return;
  await table.update({ userId: event.aggregateId }, { name });
};
