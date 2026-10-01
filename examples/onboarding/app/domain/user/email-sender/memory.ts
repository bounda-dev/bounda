import type { Implementation } from "./+types/memory";
import type { WelcomeEmail } from "./index.ts";

/**
 * Keeps each welcome email in this app instead of sending it, once per idempotency key, as a
 * provider that honours the key would. For running the app without a provider.
 */
export const create = (() => {
  const sent = new Map<string, WelcomeEmail>();
  return {
    send: async (email, idempotencyKey) => {
      if (!sent.has(idempotencyKey)) sent.set(idempotencyKey, email);
    },
  };
}) satisfies Implementation.Create;
