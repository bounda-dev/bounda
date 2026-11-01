import { asDuration } from "@bounda-dev/core";
import type { Policy } from "./+types/schedule-activation-reminder-on-user-registered";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  const { email, name } = event.payload;
  if (email === null || name === null) return;
  await commands.sendActivationReminder(
    { userId: event.aggregateId, email, name },
    { delay: asDuration(process.env.ACTIVATION_REMINDER_DELAY ?? "3d") },
  );
};
