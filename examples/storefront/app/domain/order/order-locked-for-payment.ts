import type { Event } from "./+types/order-locked-for-payment";

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, status: "paying" as const });
