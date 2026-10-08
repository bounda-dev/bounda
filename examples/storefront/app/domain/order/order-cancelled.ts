import type { Event } from "./+types/order-cancelled";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ reason: z.string() });

export const apply = ({ event }: Event.ApplyArgs) => ({
  status: "cancelled" as const,
  cancelledAt: event.timestamp,
  cancellationReason: event.payload.reason,
});
