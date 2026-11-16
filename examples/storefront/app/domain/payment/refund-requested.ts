import type { Event } from "./+types/refund-requested";

export const payload = ({ z, notPersonal }: Event.PayloadArgs) =>
  z.object({
    orderId: notPersonal(z.string()),
    intentId: notPersonal(z.string()),
    amount: z.number().positive(),
  });

export const evolve = () => ({ refund: "due" as const });
