import type { Event } from "./+types/order-cancelled";

export const evolve = ({ state }: Event.EvolveArgs) => ({ ...state, status: "cancelled" as const });
