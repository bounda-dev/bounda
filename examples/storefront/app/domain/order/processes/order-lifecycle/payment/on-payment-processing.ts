import type { Process } from "./+types/on-payment-processing";

export const handler = async ({ aggregateId, commands }: Process.HandlerArgs) => {
  await commands.lockOrderForPayment({ orderId: aggregateId });
  return { paymentDeadline: null };
};
