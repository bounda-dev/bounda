import type { Process } from "./+types/on-payment-processing";

export const handler = async ({ state, aggregateId, commands }: Process.HandlerArgs) => {
  await commands.lockOrderForPayment({ orderId: aggregateId });
  return { ...state, paymentDeadline: null };
};
