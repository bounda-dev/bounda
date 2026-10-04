import type { Process } from "./+types/on-order-paid";

export const handler = async ({ state, aggregateId, commands }: Process.HandlerArgs) => {
  await commands.fulfillOrder({ orderId: aggregateId });
  return state;
};
