import type { Collaborators, WelcomeEmail } from "./index.ts";

/**
 * Every welcome email "sent" so far, once per idempotency key, as a provider that honours the key
 * would. Tests read it; nothing else should.
 */
export const sent: WelcomeEmail[] = [];
const seen = new Set<string>();

export default {
  send: async (email, idempotencyKey) => {
    if (seen.has(idempotencyKey)) return;
    seen.add(idempotencyKey);
    sent.push(email);
  },
} satisfies Collaborators["emailSender"];
