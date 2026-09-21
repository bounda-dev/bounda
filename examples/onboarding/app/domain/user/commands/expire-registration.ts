import type { Command } from "./+types/expire-registration";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ userId: z.uuid() });

export const handler = ({ state, events }: Command.HandlerArgs) =>
  state.status === "registered" ? [events.registrationExpired()] : [];
