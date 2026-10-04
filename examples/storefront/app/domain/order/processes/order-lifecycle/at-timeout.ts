import type { Process } from "./+types/at-timeout";

// A process that times out ends without handling the OrderCancelled it causes, so it compensates
// here instead of in on-order-cancelled.
export const handler = async ({ state, aggregateId, commands }: Process.DeadlineArgs) => {
  const reason = "not completed in time";
  await commands.recordPaymentFailure({ orderId: aggregateId, reason });
  await commands.cancelOrder({ orderId: aggregateId, reason });
  if (state.paymentId !== null) {
    await commands.cancelPayment({ paymentId: state.paymentId, reason });
  }
  return state;
};
