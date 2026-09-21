import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/activate-user";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ userId: z.uuid() });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  switch (state.status) {
    case "registered":
      return [events.userActivated()];
    case "active":
      throw new DomainError(`User ${command.aggregateId} is already active`);
    case "expired":
      throw new DomainError(`The registration of user ${command.aggregateId} has expired`);
    default:
      throw new DomainError(`User ${command.aggregateId} does not exist`);
  }
};
