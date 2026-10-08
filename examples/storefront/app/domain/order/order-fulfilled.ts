import type { Event } from "./+types/order-fulfilled";

export const evolve = ({ event }: Event.EvolveArgs) => ({
  status: "fulfilled" as const,
  fulfilledAt: event.timestamp,
});
