import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/index";

export type Collaborators = {
  inventory: { reserve: (skus: readonly string[]) => Promise<void> };
};

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({
    orderId: z.uuid(),
    customerId: z.string(),
    lines: z
      .array(z.object({ sku: z.string(), quantity: z.int().positive(), unitPrice: z.number() }))
      .min(1),
  });

export const handler = async ({ command, state, events, inventory }: Command.HandlerArgs) => {
  if (state.status !== "new") throw new DomainError(`Order ${command.aggregateId} already placed`);
  await inventory.reserve(command.payload.lines.map((line) => line.sku));
  return [
    events.orderPlaced({ customerId: command.payload.customerId, lines: command.payload.lines }),
  ];
};
