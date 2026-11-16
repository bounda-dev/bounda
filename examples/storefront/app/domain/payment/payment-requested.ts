import type { Event } from "./+types/payment-requested";

export const payload = ({ z, notPersonal }: Event.PayloadArgs) =>
  z.object({
    orderId: notPersonal(z.string()),
    amount: z.number().positive(),
    intentId: notPersonal(z.string()),
  });

export const begin = ({ event }: Event.BeginArgs) => ({
  status: "requested" as const,
  orderId: event.payload.orderId,
  amount: event.payload.amount,
  intentId: event.payload.intentId,
  refund: "none" as const,
});
