import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/place-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({
    orderId: z.uuid(),
    customerId: z.string().min(1),
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          quantity: z.int().positive(),
          price: z.number().positive(),
        }),
      )
      .min(1),
  });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  if (state.status !== undefined) {
    throw new DomainError(`Order ${command.aggregateId} was already placed`);
  }
  const { customerId, items } = command.payload;
  const total = items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  return [events.orderPlaced({ customerId, items, total })];
};
