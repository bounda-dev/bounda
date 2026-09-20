import type { Event } from "./+types/order-paid";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ method: z.enum(["card", "transfer"]) });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "paid" as const,
  paidWith: event.payload.method,
});
