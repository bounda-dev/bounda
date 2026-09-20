import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/place-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({
    orderId: z.uuid(),
    customerId: z.string(),
    lines: z.array(z.object({ sku: z.string(), quantity: z.int().positive() })).min(1),
  });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  if (state.status !== undefined) throw new DomainError(`Order ${command.aggregateId} exists`);
  return [
    events.orderPlaced({ customerId: command.payload.customerId, lines: command.payload.lines }),
  ];
};
