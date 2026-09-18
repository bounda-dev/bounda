import type { Event } from "./+types/order-cancelled";

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, status: "cancelled" as const });
