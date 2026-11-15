import type { CreateImplementation } from "@bounda-dev/core";
import type { EmailSender } from "../../email-sender.ts";

export const create: CreateImplementation<EmailSender> = ({ env, logger }) => {
  const from = env.EMAIL_FROM ?? "welcome@onboarding.localhost";
  return {
    send: async ({ template, userId, to, name, idempotencyKey }) => {
      logger.info(`${template} email`, { from, userId, to, name, idempotencyKey });
    },
    erase: async ({ userId, idempotencyKey }) => {
      logger.info("contact erased", { userId, idempotencyKey });
    },
    suppress: async ({ userId, idempotencyKey }) => {
      logger.info("contact suppressed", { userId, idempotencyKey });
    },
    resume: async ({ userId, idempotencyKey }) => {
      logger.info("contact resumed", { userId, idempotencyKey });
    },
  };
};
