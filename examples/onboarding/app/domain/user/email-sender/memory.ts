import type { Implementation } from "./+types/memory";
import type { WelcomeEmail } from "./index.ts";

/**
 * Every welcome email "sent" so far, once per idempotency key, as a provider that honours the key
 * would. Tests read it; nothing else should.
 */
export const sent: WelcomeEmail[] = [];
const sentWithKey = new Map<string, WelcomeEmail>();

export default {
  send: async (email, idempotencyKey) => {
    const previous = sentWithKey.get(idempotencyKey);
    if (previous !== undefined && sent.includes(previous)) return;
    sentWithKey.set(idempotencyKey, email);
    sent.push(email);
  },
} satisfies Implementation.Contract;
