import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/register-user";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ userId: z.uuid(), email: z.email(), name: z.string().min(1) });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  if (state.status !== "new") {
    throw new DomainError(`User ${command.aggregateId} is already registered`);
  }
  const { email, name } = command.payload;
  return [events.userRegistered({ email, name })];
};
