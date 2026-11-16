import type { Event } from "./+types/payment-settled";

export const payload = ({ z, notPersonal }: Event.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.string()) });

export const evolve = () => ({ status: "settled" as const });
