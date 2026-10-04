import type { Event } from "./+types/order-paid";

export const apply = ({ event }: Event.ApplyArgs) => ({
  status: "paid" as const,
  paidAt: event.timestamp,
});
