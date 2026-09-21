import type { Event } from "./+types/user-activated";

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, status: "active" as const });
