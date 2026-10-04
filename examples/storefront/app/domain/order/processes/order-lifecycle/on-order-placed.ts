import { asDuration, idempotencyKeyFor } from "@bounda-dev/core";
import type { Process } from "./+types/on-order-placed";

export const handler = async ({
  event,
  aggregateId,
  commands,
  idempotencyKey,
  after,
}: Process.HandlerArgs) => {
  const paymentId = idempotencyKeyFor(idempotencyKey, "payment");
  await commands.requestPayment({ paymentId, orderId: aggregateId, amount: event.payload.total });
  return {
    paymentId,
    paymentDeadline: after(asDuration(process.env.PAYMENT_WINDOW ?? "72h")),
  };
};
