import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/pay-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), method: z.enum(["card", "transfer"]), reference: z.string() });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  if (state.status !== "placed") throw new DomainError("Only placed orders can be paid");
  return [
    events.orderPaid({ method: command.payload.method, reference: command.payload.reference }),
  ];
};
