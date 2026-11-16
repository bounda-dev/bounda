import type { Command } from "./+types/record-welcome-email-sent";

export const payload = ({ z, personal, person }: Command.PayloadArgs) =>
  z.object({ userId: person(z.uuid()), to: personal(z.email(), { category: "account" }) });

export const handler = ({ command, state, events }: Command.HandlerArgs) =>
  state.welcomeEmailSent !== false ? [] : [events.welcomeEmailSent({ to: command.payload.to })];
