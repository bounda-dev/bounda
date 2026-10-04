import type { Process } from "./+types/on-payment-declined";

// Both commands run in one attempt, and the second sees what the first decided: the order is
// placed again by the time it is cancelled.
export const handler = async ({ event, aggregateId, commands }: Process.HandlerArgs) => {
  await commands.recordPaymentFailure({ orderId: aggregateId, reason: event.payload.reason });
  await commands.cancelOrder({ orderId: aggregateId, reason: "payment declined" });
  return { paymentDeadline: null };
};
