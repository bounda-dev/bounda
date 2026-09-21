import type { Command } from "./+types/index";

export interface WelcomeEmail {
  readonly to: string;
  readonly name: string;
}

export type Collaborators = {
  emailSender: { send: (email: WelcomeEmail) => Promise<void> };
};

export const payload = ({ z }: Command.PayloadArgs) => z.object({ userId: z.uuid() });

export const handler = async ({ state, events, emailSender }: Command.HandlerArgs) => {
  if (state.status === "new" || state.welcomeEmailSent) return [];
  await emailSender.send({ to: state.email, name: state.name });
  return [events.welcomeEmailSent({ to: state.email })];
};
