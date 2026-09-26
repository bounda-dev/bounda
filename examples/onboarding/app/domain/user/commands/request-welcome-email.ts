import type { Command } from "./+types/request-welcome-email";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ userId: z.uuid() });

export const handler = ({ state, events }: Command.HandlerArgs) =>
  state.status === "new" || state.welcomeEmailRequested
    ? []
    : [events.welcomeEmailRequested({ to: state.email, name: state.name })];
