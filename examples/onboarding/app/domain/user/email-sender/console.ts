import type { Implementation } from "./+types/console";

export const create: Implementation.Create = ({ env, logger }) => {
  const from = env.EMAIL_FROM ?? "welcome@onboarding.localhost";
  return {
    send: async ({ to, name }, idempotencyKey) => {
      logger.info("welcome email", { from, to, name, idempotencyKey });
    },
  };
};
