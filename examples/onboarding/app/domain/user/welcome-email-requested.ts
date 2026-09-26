import type { Event } from "./+types/welcome-email-requested";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ to: z.email(), name: z.string().min(1) });

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, welcomeEmailRequested: true });
