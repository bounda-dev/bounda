import type { Event } from "./+types/order-fulfilled";

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "fulfilled" as const,
  fulfilledAt: event.timestamp,
});
