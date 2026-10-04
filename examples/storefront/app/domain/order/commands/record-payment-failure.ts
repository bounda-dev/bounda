import type { Command } from "./+types/record-payment-failure";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), reason: z.string().min(1) });

// Dispatched by the process, like lockOrderForPayment: any state but `paying` answers with nothing.
export const handler = ({ command, state, events }: Command.HandlerArgs) =>
  state.status === "paying" ? [events.orderPaymentFailed({ reason: command.payload.reason })] : [];
