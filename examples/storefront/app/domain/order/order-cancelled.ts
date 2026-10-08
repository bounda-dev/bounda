import type { Event } from "./+types/order-cancelled";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ reason: z.string() });

export const evolve = ({ event }: Event.EvolveArgs) => ({
  status: "cancelled" as const,
  cancelledAt: event.timestamp,
  cancellationReason: event.payload.reason,
});
