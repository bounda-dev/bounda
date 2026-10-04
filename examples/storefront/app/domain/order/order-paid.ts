import type { Event } from "./+types/order-paid";

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "paid" as const,
  paidAt: event.timestamp,
});
