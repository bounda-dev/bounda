import type { Projection } from "./+types/welcome-email-sent";

export const project = async ({ event, table }: Projection.Args) => {
  await table.update(
    { userId: event.aggregateId },
    { welcomeEmailSentAt: new Date(event.timestamp) },
  );
};
