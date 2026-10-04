import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/mark-order-paid";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

// A refusal makes the process refund the payment, so only an order that can no longer be paid
// refuses: a paid or fulfilled one answers a repeat with nothing.
export const handler = ({ state, events }: Command.HandlerArgs) => {
  if (state.status === "paid" || state.status === "fulfilled") return [];
  if (state.status !== "placed" && state.status !== "paying") {
    throw new DomainError(`Only open orders can be paid; this one is ${state.status ?? "new"}`);
  }
  return [events.orderPaid()];
};
