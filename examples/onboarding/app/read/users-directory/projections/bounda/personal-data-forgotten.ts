import type { Projection } from "./+types/personal-data-forgotten";

export const project = async ({ event, table }: Projection.Args) => {
  await table.delete({ userId: event.payload.personId });
};
