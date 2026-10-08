import type { CreateImplementation } from "@bounda-dev/core";
import type { EmailSender } from "../../email-sender.ts";

export const create: CreateImplementation<EmailSender> = ({ env, logger }) => {
  const from = env.EMAIL_FROM ?? "welcome@onboarding.localhost";
  return async ({ to, name, idempotencyKey }) => {
    logger.info("welcome email", { from, to, name, idempotencyKey });
  };
};
