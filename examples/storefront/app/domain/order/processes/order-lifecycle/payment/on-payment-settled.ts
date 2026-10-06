import type { Process } from "./+types/on-payment-settled";

export const handler = async ({ event, aggregateId, commands }: Process.HandlerArgs) => {
  const paid = await commands.markOrderPaid({ orderId: aggregateId });
  if (paid.rejected === "NotOpen") {
    await commands.cancelPayment({ paymentId: event.aggregateId, reason: "order no longer open" });
  }
  return { paymentDeadline: null };
};
