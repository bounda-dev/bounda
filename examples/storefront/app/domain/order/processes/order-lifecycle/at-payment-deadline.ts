import type { Process } from "./+types/at-payment-deadline";

export const handler = async ({ aggregateId, commands }: Process.DeadlineArgs) => {
  await commands.cancelOrder({ orderId: aggregateId, reason: "not paid in time" });
  return { paymentDeadline: null };
};
