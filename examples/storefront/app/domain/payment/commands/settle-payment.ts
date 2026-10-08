import type { Command } from "./+types/settle-payment";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ paymentId: z.uuid() });

// A webhook, which may arrive twice or out of order. A declined intent can still be paid later,
// and by then the order is cancelled: money that arrives for a payment the app gave up on goes
// back. A refund already requested means this payment had settled before.
export const rejections = ({ command }: Command.RejectionsArgs) => ({
  NeverRequested: `Payment ${command.aggregateId} was never requested`,
});

export const handler = ({ state, events, reject }: Command.HandlerArgs) => {
  switch (state.status) {
    case undefined:
      return reject("NeverRequested");
    case "requested":
    case "processing":
      return [events.paymentSettled({ orderId: state.orderId })];
    case "cancelled":
    case "declined":
      return state.refund === "none"
        ? [
            events.paymentSettled({ orderId: state.orderId }),
            events.refundRequested({
              orderId: state.orderId,
              intentId: state.intentId,
              amount: state.amount,
            }),
          ]
        : [];
    case "settled":
      return [];
  }
};
