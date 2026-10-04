import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/cancel-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), reason: z.string().min(1) });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  if (state.status === "paying") throw new DomainError("Payment in progress");
  if (state.status !== "placed" && state.status !== "paid") {
    throw new DomainError(`Order cannot be cancelled while ${state.status ?? "new"}`);
  }
  return [events.orderCancelled({ reason: command.payload.reason })];
};
