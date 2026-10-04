import type { Event } from "./+types/payment-refunded";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ orderId: z.string(), refundId: z.string() });

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, refund: "done" as const });
