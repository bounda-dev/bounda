import type { Policy } from "./+types/greet-on-customer-registered";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  await commands.cancelOrder({
    orderId: event.aggregateId,
    reason: `hello ${event.payload.email}`,
  });
};
