import type { Process } from "./+types/on-order-cancelled";

// Every compensation goes through here, whoever cancelled the order: it completes the process,
// and its handler runs before the instance completes.
export const handler = async ({ state, event, commands }: Process.HandlerArgs) => {
  if (state.paymentId !== null) {
    await commands.cancelPayment({ paymentId: state.paymentId, reason: event.payload.reason });
  }
};
