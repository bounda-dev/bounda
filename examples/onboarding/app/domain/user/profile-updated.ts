import type { Event } from "./+types/profile-updated";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ name: z.string().min(1) });

export const apply = ({ event }: Event.ApplyArgs) => ({ name: event.payload.name });
