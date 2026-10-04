import type { Command } from "./+types/record-refund";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ paymentId: z.uuid(), refundId: z.string().min(1) });

export const handler = ({ command, state, events }: Command.HandlerArgs) =>
  state.refund === "due"
    ? [events.paymentRefunded({ orderId: state.orderId, refundId: command.payload.refundId })]
    : [];
