import type { Event } from "./+types/payment-settled";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ orderId: z.string() });

export const apply = () => ({ status: "settled" as const });
