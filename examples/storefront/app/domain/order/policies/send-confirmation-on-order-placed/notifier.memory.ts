import type { Collaborators, Confirmation } from "./index.ts";

/**
 * Every confirmation "sent" so far, once per idempotency key, as a provider that honours the key
 * would. Tests read it; nothing else should.
 */
export const sent: Confirmation[] = [];
const seen = new Set<string>();

export default {
  send: async (confirmation, idempotencyKey) => {
    if (seen.has(idempotencyKey)) return;
    seen.add(idempotencyKey);
    sent.push(confirmation);
  },
} satisfies Collaborators["notifier"];
