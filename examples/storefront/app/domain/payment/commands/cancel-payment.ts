import type { Command } from "./+types/cancel-payment";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ paymentId: z.uuid(), reason: z.string().min(1) });

// The compensation of requestPayment. The intent stays open, since cancelling it would not stop a
// customer paying that same second: a payment that settles afterwards is refunded instead.
export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  const { reason } = command.payload;
  switch (state.status) {
    case "requested":
    case "processing":
      return [events.paymentCancelled({ orderId: state.orderId, reason })];
    case "settled":
      return state.refund === "none"
        ? [
            events.paymentCancelled({ orderId: state.orderId, reason }),
            events.refundRequested({
              orderId: state.orderId,
              intentId: state.intentId,
              amount: state.amount,
            }),
          ]
        : [];
    default:
      return [];
  }
};
