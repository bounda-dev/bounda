import type { Process } from "./+types/on-order-confirmed";

export const handler = async ({ state, aggregateId, commands }: Process.HandlerArgs) => {
  await commands.fulfillOrder({ orderId: aggregateId });
  return { ...state, autoFulfilled: true };
};
