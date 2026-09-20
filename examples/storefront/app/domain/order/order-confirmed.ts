import type { Event } from "./+types/order-confirmed";

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "confirmed" as const,
  confirmedAt: event.timestamp,
});
