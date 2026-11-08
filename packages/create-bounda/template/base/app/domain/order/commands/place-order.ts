import type { Command } from "./+types/place-order";

export const payload = ({ z, person, personal }: Command.PayloadArgs) =>
  z.object({
    orderId: z.uuid(),
    customerId: person(z.string().min(1)),
    total: z.number().positive(),
    deliveryNote: personal(z.string().min(1)).optional(),
  });

export const rejections = ({ command }: Command.RejectionsArgs) => ({
  AlreadyPlaced: `Order ${command.aggregateId} was already placed`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== undefined) return reject("AlreadyPlaced");
  const { customerId, total, deliveryNote } = command.payload;
  return [events.orderPlaced({ customerId, total, deliveryNote })];
};
