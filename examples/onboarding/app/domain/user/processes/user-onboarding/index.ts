import type { Process } from "./+types/index";

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.user.UserRegistered],
  completedBy: [events.user.UserActivated, events.user.RegistrationExpired],
  timeout: process.env.ONBOARDING_TIMEOUT ?? "7d",
});

export const state = ({ z, notPersonal }: Process.StateArgs) =>
  z.object({ welcomeEmailSent: notPersonal(z.boolean()).default(false) });
