import type { Event } from "./+types/welcome-email-sent";

export const payload = ({ z, personal }: Event.PayloadArgs) =>
  z.object({ to: personal(z.email(), { category: "account" }) });

export const evolve = () => ({ welcomeEmailSent: true });
