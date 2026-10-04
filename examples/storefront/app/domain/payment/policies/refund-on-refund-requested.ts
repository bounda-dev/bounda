import type { Policy } from "./+types/refund-on-refund-requested";

export const handler = async ({ event, commands, gateway, idempotencyKey }: Policy.HandlerArgs) => {
  const { intentId, amount } = event.payload;
  const { refundId } = await gateway.refund({ intentId, amount }, idempotencyKey);
  await commands.recordRefund({ paymentId: event.aggregateId, refundId });
};
