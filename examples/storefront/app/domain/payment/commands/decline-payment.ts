import type { Command } from "./+types/decline-payment";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ paymentId: z.uuid(), reason: z.string().min(1) });

// A webhook, like settlePayment: once the payment settled or was cancelled it changes nothing.
export const handler = ({ command, state, events }: Command.HandlerArgs) =>
  state.status === "requested" || state.status === "processing"
    ? [events.paymentDeclined({ orderId: state.orderId, reason: command.payload.reason })]
    : [];
