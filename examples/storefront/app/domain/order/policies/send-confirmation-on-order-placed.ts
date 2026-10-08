import type { Policy } from "./+types/send-confirmation-on-order-placed";

export const handler = async ({
  event,
  commands,
  notifier,
  idempotencyKey,
}: Policy.HandlerArgs) => {
  await notifier({
    orderId: event.aggregateId,
    customerId: event.payload.customerId,
    total: event.payload.total,
    idempotencyKey,
  });
  await commands.recordConfirmationSent({ orderId: event.aggregateId });
};
