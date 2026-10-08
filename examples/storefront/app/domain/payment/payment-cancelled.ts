import type { Event } from "./+types/payment-cancelled";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ orderId: z.string(), reason: z.string() });

export const apply = () => ({ status: "cancelled" as const });
