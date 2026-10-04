import { asDuration } from "@bounda-dev/core";
import type { Process } from "./+types/on-order-placed";

// The payment id is the handler's idempotency key, not a random one: a retry has to request the
// same payment, which the provider sees as the same key with the same parameters.
export const handler = async ({
  state,
  event,
  aggregateId,
  commands,
  idempotencyKey,
  after,
}: Process.HandlerArgs) => {
  await commands.requestPayment({
    paymentId: idempotencyKey,
    orderId: aggregateId,
    amount: event.payload.total,
  });
  return {
    ...state,
    paymentId: idempotencyKey,
    paymentDeadline: after(asDuration(process.env.PAYMENT_WINDOW ?? "72h")),
  };
};
