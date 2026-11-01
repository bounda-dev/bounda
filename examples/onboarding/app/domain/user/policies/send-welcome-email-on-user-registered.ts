import { asDuration } from "@bounda-dev/core";
import type { Policy } from "./+types/send-welcome-email-on-user-registered";

export const delay = asDuration(process.env.WELCOME_EMAIL_DELAY ?? "1m");

export const handler = async ({
  event,
  commands,
  emailSender,
  idempotencyKey,
}: Policy.HandlerArgs) => {
  const { email, name } = event.payload;
  if (email === null || name === null) return;
  await emailSender({ template: "welcome", to: email, name, idempotencyKey });
  await commands.recordWelcomeEmailSent({ userId: event.aggregateId, to: email });
};
