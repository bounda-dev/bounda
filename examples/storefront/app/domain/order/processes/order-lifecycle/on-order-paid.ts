import type { Process } from "./+types/on-order-paid";

export const handler = async ({ aggregateId, commands }: Process.HandlerArgs) => {
  await commands.fulfillOrder({ orderId: aggregateId });
};
