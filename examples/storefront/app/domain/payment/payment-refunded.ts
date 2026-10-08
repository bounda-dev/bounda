import type { Event } from "./+types/payment-refunded";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ orderId: z.string(), refundId: z.string() });

export const evolve = () => ({ refund: "done" as const });
