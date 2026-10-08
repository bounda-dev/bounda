import type { Event } from "./+types/order-paid";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ method: z.enum(["card", "transfer"]) });

export const evolve = ({ event }: Event.EvolveArgs) => ({
  status: "paid" as const,
  paidWith: event.payload.method,
});
