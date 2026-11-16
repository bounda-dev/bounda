import type { Event } from "./+types/payment-processing";

export const payload = ({ z, notPersonal }: Event.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.string()) });

export const evolve = () => ({ status: "processing" as const });
