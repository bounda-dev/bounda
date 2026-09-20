import type { Event } from "./+types/order-cancelled";

interface Cancellation {
  readonly reason: string;
}

export const payload = ({ z }: Event.PayloadArgs) => z.object({ reason: z.string() });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "cancelled" as const,
  cancellation: { reason: event.payload.reason } as Cancellation,
});
