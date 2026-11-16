import type { Command } from "./+types/record-refund";

export const payload = ({ z, notPersonal }: Command.PayloadArgs) =>
  z.object({ paymentId: notPersonal(z.uuid()), refundId: notPersonal(z.string().min(1)) });

export const handler = ({ command, state, events }: Command.HandlerArgs) =>
  state.refund === "due"
    ? [events.paymentRefunded({ orderId: state.orderId, refundId: command.payload.refundId })]
    : [];
