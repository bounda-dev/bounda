import type { Event } from "./+types/payment-processing";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ orderId: z.string() });

export const apply = () => ({ status: "processing" as const });
