import type { Event } from "./+types/order-payment-failed";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ reason: z.string() });

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, status: "placed" as const });
