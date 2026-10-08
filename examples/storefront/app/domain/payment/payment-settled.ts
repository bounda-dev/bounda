import type { Event } from "./+types/payment-settled";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ orderId: z.string() });

export const evolve = () => ({ status: "settled" as const });
