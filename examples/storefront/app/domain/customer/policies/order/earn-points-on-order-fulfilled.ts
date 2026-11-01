import type { Policy } from "./+types/earn-points-on-order-fulfilled";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  await commands.earnPoints({
    customerId: event.payload.customerId,
    orderId: event.aggregateId,
    points: Math.floor(event.payload.total),
  });
};
