import type { Event } from "./+types/registration-expired";

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, status: "expired" as const });
