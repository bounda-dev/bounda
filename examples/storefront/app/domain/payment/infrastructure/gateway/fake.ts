import type { CreateImplementation } from "@bounda-dev/core";
import type { Gateway } from "../../gateway.ts";

/**
 * Answers in this app instead of calling a provider: one intent and one refund per idempotency
 * key, as a provider that honours the key would, with ids that follow the order of the calls.
 */
export const create: CreateImplementation<Gateway> = () => {
  const intents = new Map<string, string>();
  const refunds = new Map<string, string>();
  return {
    createIntent: async ({ idempotencyKey }) => {
      const intentId = intents.get(idempotencyKey) ?? `pi_${intents.size + 1}`;
      intents.set(idempotencyKey, intentId);
      return { intentId };
    },
    refund: async ({ idempotencyKey }) => {
      const refundId = refunds.get(idempotencyKey) ?? `re_${refunds.size + 1}`;
      refunds.set(idempotencyKey, refundId);
      return { refundId };
    },
  };
};
