import type { Event } from "./+types/profile-updated";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ name: z.string().min(1) });

export const evolve = ({ event }: Event.EvolveArgs) => ({ name: event.payload.name });
