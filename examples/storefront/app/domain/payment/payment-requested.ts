import type { Event } from "./+types/payment-requested";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ orderId: z.string(), amount: z.number().positive(), intentId: z.string() });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "requested" as const,
  orderId: event.payload.orderId,
  amount: event.payload.amount,
  intentId: event.payload.intentId,
});
