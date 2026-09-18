import type { Policy } from "./+types/send-receipt-on-order-paid";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  await commands.cancelOrder({
    orderId: event.aggregateId,
    reason: `receipt for ${event.payload.method}`,
  });
};
