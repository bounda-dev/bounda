import type { Projection } from "./+types/user-registered";

export const project = async ({ event, table }: Projection.Args) => {
  await table.upsert({
    userId: event.aggregateId,
    email: event.payload.email,
    name: event.payload.name,
    status: "registered",
    registeredAt: new Date(event.timestamp),
  });
};
