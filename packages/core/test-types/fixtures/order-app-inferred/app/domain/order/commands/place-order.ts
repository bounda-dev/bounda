import type { Command } from "./+types/place-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({
    orderId: z.uuid(),
    customerId: z.string(),
    lines: z.array(z.object({ sku: z.string(), quantity: z.int().positive() })).min(1),
  });

export const rejections = ({ command, state }: Command.RejectionsArgs) => ({
  Exists: `Order ${command.aggregateId} is already ${state.status ?? "new"}`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== undefined) return reject("Exists");
  return [
    events.orderPlaced({ customerId: command.payload.customerId, lines: command.payload.lines }),
  ];
};
