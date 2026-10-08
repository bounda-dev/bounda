import type { CreateImplementation } from "@bounda-dev/core";
import type { EmailSender, EmailSenderArgs } from "../../email-sender.ts";

/**
 * Keeps each welcome email in this app instead of sending it, once per idempotency key, as a
 * provider that honours the key would. For running the app without a provider.
 */
export const create: CreateImplementation<EmailSender> = () => {
  const sent = new Map<string, EmailSenderArgs>();
  return async (email) => {
    if (!sent.has(email.idempotencyKey)) sent.set(email.idempotencyKey, email);
  };
};
