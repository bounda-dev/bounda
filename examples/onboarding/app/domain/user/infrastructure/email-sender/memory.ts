import type { CreateImplementation } from "@bounda-dev/core";
import type { EmailSender, EmailSenderArgs } from "../../email-sender.ts";

/**
 * Keeps each email in this app instead of sending it, once per idempotency key, as a provider that
 * honours the key would, and the contacts under the user's id. For running the app without a
 * provider.
 */
export const create: CreateImplementation<EmailSender> = () => {
  const sent = new Map<string, EmailSenderArgs>();
  const suppressed = new Set<string>();
  return {
    send: async (email) => {
      if (suppressed.has(email.userId) || sent.has(email.idempotencyKey)) return;
      sent.set(email.idempotencyKey, email);
    },
    erase: async ({ userId }) => {
      for (const [key, email] of sent) if (email.userId === userId) sent.delete(key);
    },
    suppress: async ({ userId }) => {
      suppressed.add(userId);
    },
    resume: async ({ userId }) => {
      suppressed.delete(userId);
    },
  };
};
