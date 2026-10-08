import type { Event } from "./+types/order-paid";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ method: z.enum(["card", "transfer"]), reference: z.string() });

export const evolve = ({ state }: Event.EvolveArgs) => ({ ...state, status: "paid" as const });
