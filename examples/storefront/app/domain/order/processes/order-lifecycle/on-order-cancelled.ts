import type { Process } from "./+types/on-order-cancelled";

// Every compensation goes through here, whoever cancelled the order: the handler of the event that
// completes the process runs before the instance completes, and one the timeout caused still runs.
export const handler = async ({ state, event, commands }: Process.HandlerArgs) => {
  if (state.paymentId !== null) {
    await commands.cancelPayment({ paymentId: state.paymentId, reason: event.payload.reason });
  }
};
