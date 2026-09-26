import type { Projection } from "./+types/registration-expired";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update({ userId: event.aggregateId }, { status: "expired" });
};
