import type { Event } from "./+types/order-cancelled";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ reason: z.string() });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "cancelled" as const,
  cancelledAt: event.timestamp,
  cancellationReason: event.payload.reason,
});
