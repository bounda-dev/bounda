import type { Event } from "./+types/payment-cancelled";

export const payload = ({ z, notPersonal }: Event.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.string()), reason: notPersonal(z.string()) });

export const evolve = () => ({ status: "cancelled" as const });
