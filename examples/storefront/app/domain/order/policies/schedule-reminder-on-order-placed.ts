import { asDuration } from "@bounda-dev/core";
import type { Policy } from "./+types/schedule-reminder-on-order-placed";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  await commands.sendReminder(
    { orderId: event.aggregateId },
    { delay: asDuration(process.env.REMINDER_DELAY ?? "24h") },
  );
};
