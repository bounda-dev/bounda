import type { Implementation } from "./+types/memory";
import type { Confirmation } from "./index.ts";

/**
 * Keeps each confirmation in this app instead of sending it, once per idempotency key, as a
 * provider that honours the key would. For running the app without a provider.
 */
export const create = (() => {
  const sent = new Map<string, Confirmation>();
  return async (confirmation, idempotencyKey) => {
    if (!sent.has(idempotencyKey)) sent.set(idempotencyKey, confirmation);
  };
}) satisfies Implementation.Create;
