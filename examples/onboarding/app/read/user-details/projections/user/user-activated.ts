import type { Projection } from "./+types/user-activated";

export const project = async ({ event, table }: Projection.Args) => {
  const { actor } = event.metadata;
  await table.update(
    { userId: event.aggregateId },
    {
      status: "active",
      activatedAt: new Date(event.timestamp),
      ...(actor === undefined ? {} : { activatedBy: actor }),
    },
  );
};
