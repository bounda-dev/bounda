import type { Event } from "./+types/order-paid";

export const evolve = ({ event }: Event.EvolveArgs) => ({
  status: "paid" as const,
  paidAt: event.timestamp,
});
