import type { Command } from "./+types/mark-payment-processing";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ paymentId: z.uuid() });

// A webhook: the provider may repeat it, or send it after the payment already settled or failed.
export const handler = ({ state, events }: Command.HandlerArgs) =>
  state.status === "requested" ? [events.paymentProcessing({ orderId: state.orderId })] : [];
