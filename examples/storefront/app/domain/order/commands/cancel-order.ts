import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/cancel-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), reason: z.string().min(1) });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  if (state.status !== "placed" && state.status !== "confirmed") {
    throw new DomainError(`Order cannot be cancelled while ${state.status ?? "new"}`);
  }
  return [events.orderCancelled({ reason: command.payload.reason })];
};
