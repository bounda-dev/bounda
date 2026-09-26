import type { Command } from "./+types/record-welcome-email-sent";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ userId: z.uuid(), to: z.email() });

export const handler = ({ command, state, events }: Command.HandlerArgs) =>
  state.welcomeEmailSent ? [] : [events.welcomeEmailSent({ to: command.payload.to })];
