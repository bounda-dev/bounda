import { DomainError } from "@bounda-dev/core";
import type { Process } from "./+types/on-payment-settled";

export const handler = async ({ state, event, aggregateId, commands }: Process.HandlerArgs) => {
  try {
    await commands.markOrderPaid({ orderId: aggregateId });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    await commands.cancelPayment({ paymentId: event.aggregateId, reason: "order no longer open" });
  }
  return { ...state, paymentDeadline: null };
};
