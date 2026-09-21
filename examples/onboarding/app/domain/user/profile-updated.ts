import type { Event } from "./+types/profile-updated";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ name: z.string().min(1) });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  name: event.payload.name,
});
