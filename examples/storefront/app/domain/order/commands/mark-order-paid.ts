import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/mark-order-paid";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

export const handler = ({ state, events }: Command.HandlerArgs) => {
  if (state.status !== "placed" && state.status !== "paying") {
    throw new DomainError(`Only open orders can be paid; this one is ${state.status ?? "new"}`);
  }
  return [events.orderPaid()];
};
