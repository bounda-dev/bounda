import type { Event } from "./+types/user-registered";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ email: z.email(), name: z.string().min(1) });

export const begin = ({ event }: Event.BeginArgs) => ({
  status: "registered" as const,
  email: event.payload.email,
  name: event.payload.name,
  welcomeEmailSent: false,
});
