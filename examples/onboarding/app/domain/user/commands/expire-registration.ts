import type { Command } from "./+types/expire-registration";

export const payload = ({ z, person }: Command.PayloadArgs) =>
  z.object({ userId: person(z.uuid()) });

export const handler = ({ state, events }: Command.HandlerArgs) =>
  state.status === "registered" ? [events.registrationExpired()] : [];
