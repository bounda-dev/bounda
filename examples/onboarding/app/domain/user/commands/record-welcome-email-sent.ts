import type { Command } from "./+types/record-welcome-email-sent";

export const payload = ({ z, personal }: Command.PayloadArgs) =>
  z.object({ userId: z.uuid(), to: personal(z.email()) });

export const handler = ({ command, state, events }: Command.HandlerArgs) =>
  state.welcomeEmailSent !== false ? [] : [events.welcomeEmailSent({ to: command.payload.to })];
