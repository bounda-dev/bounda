import type { Event } from "./+types/welcome-email-sent";

export const payload = ({ z, personal }: Event.PayloadArgs) =>
  z.object({ to: personal(z.email()) });

export const evolve = () => ({ welcomeEmailSent: true });
