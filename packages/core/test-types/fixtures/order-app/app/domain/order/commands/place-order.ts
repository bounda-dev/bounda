import type { Command } from "./+types/place-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({
    orderId: z.uuid(),
    customerId: z.string(),
    lines: z
      .array(z.object({ sku: z.string(), quantity: z.int().positive(), unitPrice: z.number() }))
      .min(1),
  });

export const rejections = ({ command }: Command.RejectionsArgs) => ({
  AlreadyPlaced: `Order ${command.aggregateId} already placed`,
});

export const handler = async ({
  command,
  state,
  events,
  inventory,
  reject,
}: Command.HandlerArgs) => {
  if (state.status !== "new") throw reject("AlreadyPlaced");
  await inventory.reserve(command.payload.lines.map((line) => line.sku));
  return [
    events.orderPlaced({ customerId: command.payload.customerId, lines: command.payload.lines }),
  ];
};
