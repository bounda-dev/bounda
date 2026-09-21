import type { Event } from "./+types/welcome-email-sent";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ to: z.email() });

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, welcomeEmailSent: true });
