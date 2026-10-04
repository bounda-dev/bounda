import type { Event } from "./+types/user-registered";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ email: z.email(), name: z.string().min(1) });

export const create = ({ event }: Event.CreateArgs) => ({
  status: "registered" as const,
  email: event.payload.email,
  name: event.payload.name,
  welcomeEmailSent: false,
});
