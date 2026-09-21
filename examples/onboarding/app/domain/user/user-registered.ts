import type { Event } from "./+types/user-registered";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ email: z.email(), name: z.string().min(1) });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "registered" as const,
  email: event.payload.email,
  name: event.payload.name,
});
