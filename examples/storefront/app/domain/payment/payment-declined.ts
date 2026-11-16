import type { Event } from "./+types/payment-declined";

export const payload = ({ z, notPersonal }: Event.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.string()), reason: notPersonal(z.string()) });

export const evolve = () => ({ status: "declined" as const });
