import type { Event } from "./+types/order-fulfilled";

export const payload = ({ z, person }: Event.PayloadArgs) =>
  z.object({ customerId: person(z.string()), total: z.number().positive() });

export const evolve = ({ event }: Event.EvolveArgs) => ({
  status: "fulfilled" as const,
  fulfilledAt: event.timestamp,
});
