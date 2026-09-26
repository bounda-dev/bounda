import { asDuration } from "@bounda-dev/core";
import type { Process } from "./+types/on-user-registered";

export const handler = async ({ state, aggregateId, commands }: Process.HandlerArgs) => {
  await commands.requestWelcomeEmail(
    { userId: aggregateId },
    { delay: asDuration(process.env.WELCOME_EMAIL_DELAY ?? "1m") },
  );
  return state;
};
