import type { Event } from "./+types/payment-refunded";

export const payload = ({ z, notPersonal }: Event.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.string()), refundId: notPersonal(z.string()) });

export const evolve = () => ({ refund: "done" as const });
