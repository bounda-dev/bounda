import type { CreateImplementation } from "@bounda-dev/core";
import type { Notifier, NotifierArgs } from "../../notifier.ts";

/**
 * Keeps each confirmation in this app instead of sending it, once per idempotency key, as a
 * provider that honours the key would. For running the app without a provider.
 */
export const create: CreateImplementation<Notifier> = () => {
  const sent = new Map<string, NotifierArgs>();
  return async (confirmation) => {
    if (!sent.has(confirmation.idempotencyKey)) sent.set(confirmation.idempotencyKey, confirmation);
  };
};
