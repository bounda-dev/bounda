import type { Event } from "./+types/order-fulfilled";

export const apply = ({ event }: Event.ApplyArgs) => ({
  status: "fulfilled" as const,
  fulfilledAt: event.timestamp,
});
