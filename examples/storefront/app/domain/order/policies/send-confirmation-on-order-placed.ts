import type { Policy } from "./+types/send-confirmation-on-order-placed";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  await commands.sendConfirmation({ orderId: event.aggregateId });
};
