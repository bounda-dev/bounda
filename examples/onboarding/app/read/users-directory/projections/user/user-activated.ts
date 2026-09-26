import type { Projection } from "./+types/user-activated";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update({ userId: event.aggregateId }, { status: "active" });
};
