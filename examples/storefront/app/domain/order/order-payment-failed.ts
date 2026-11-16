import type { Event } from "./+types/order-payment-failed";

export const payload = ({ z, notPersonal }: Event.PayloadArgs) =>
  z.object({ reason: notPersonal(z.string()) });

export const evolve = () => ({ status: "placed" as const });
