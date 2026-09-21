import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/update-profile";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ userId: z.uuid(), name: z.string().min(1) });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  if (state.status !== "registered" && state.status !== "active") {
    throw new DomainError(`User ${command.aggregateId} cannot be updated`);
  }
  if (state.name === command.payload.name) return [];
  return [events.profileUpdated({ name: command.payload.name })];
};
