import type { Projection } from "./+types/user-registered";

// A rebuild replays the registration of a user who was forgotten, whose fields read as null:
// their row stays out, as personal-data-forgotten left it.
export const project = async ({ event, table }: Projection.Args) => {
  const { email, name } = event.payload;
  if (email === null || name === null) return;
  await table.upsert({
    userId: event.aggregateId,
    email,
    name,
    status: "registered",
    registeredAt: new Date(event.timestamp),
  });
};
