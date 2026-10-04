import type { Event } from "./+types/payment-settled";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ orderId: z.string() });

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, status: "settled" as const });
