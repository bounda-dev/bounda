import type { Process } from "./+types/index";

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.UserRegistered],
  completedBy: [events.UserActivated, events.RegistrationExpired],
  timeout: process.env.ONBOARDING_TIMEOUT ?? "7d",
});

export const state = ({ z }: Process.StateArgs) =>
  z.object({ welcomeEmailSent: z.boolean().default(false) });
