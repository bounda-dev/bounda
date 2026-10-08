import type { Event } from "./+types/order-payment-failed";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ reason: z.string() });

export const apply = () => ({ status: "placed" as const });
