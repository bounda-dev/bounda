import type { Event } from "./+types/order-cancelled";

export const payload = ({ z, notPersonal }: Event.PayloadArgs) =>
  z.object({ reason: notPersonal(z.string()) });

export const evolve = ({ event }: Event.EvolveArgs) => ({
  status: "cancelled" as const,
  cancelledAt: event.timestamp,
  cancellationReason: event.payload.reason,
});
