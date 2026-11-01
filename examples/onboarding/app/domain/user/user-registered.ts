import type { Event } from "./+types/user-registered";

export const payload = ({ z, personal }: Event.PayloadArgs) =>
  z.object({ email: personal(z.email()), name: personal(z.string().min(1)) });

export const begin = ({ event }: Event.BeginArgs) => ({
  status: "registered" as const,
  email: event.payload.email,
  name: event.payload.name,
  welcomeEmailSent: false,
  activationReminderSent: false,
});
