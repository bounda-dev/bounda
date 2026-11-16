import type { Command } from "./+types/place-order";

export const payload = ({ z, notPersonal }: Command.PayloadArgs) =>
  z.object({
    orderId: notPersonal(z.uuid()),
    customerId: notPersonal(z.string()),
    lines: notPersonal(z.array(z.object({ sku: z.string(), quantity: z.int().positive() })).min(1)),
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
