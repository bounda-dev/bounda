import type { Event } from "./+types/refund-requested";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ orderId: z.string(), intentId: z.string(), amount: z.number().positive() });

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, refund: "due" as const });
