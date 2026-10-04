import type { Event } from "./+types/payment-processing";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ orderId: z.string() });

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, status: "processing" as const });
