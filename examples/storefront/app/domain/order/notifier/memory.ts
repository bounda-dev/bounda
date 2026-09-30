import type { Implementation } from "./+types/memory";
import type { Confirmation } from "./index.ts";

/**
 * Every confirmation "sent" so far, once per idempotency key, as a provider that honours the key
 * would. Tests read it; nothing else should.
 */
export const sent: Confirmation[] = [];
const sentWithKey = new Map<string, Confirmation>();

export default (async (confirmation, idempotencyKey) => {
  const previous = sentWithKey.get(idempotencyKey);
  if (previous !== undefined && sent.includes(previous)) return;
  sentWithKey.set(idempotencyKey, confirmation);
  sent.push(confirmation);
}) satisfies Implementation.Contract;
