import type { Process } from "./+types/index";

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.order.OrderPlaced],
  completedBy: [events.order.OrderFulfilled, events.order.OrderCancelled],
  timeout: process.env.ORDER_TIMEOUT ?? "30d",
});

export const state = ({ z, deadline }: Process.StateArgs) =>
  z.object({ paymentId: z.uuid().nullable().default(null), paymentDeadline: deadline() });

export const correlate: Process.Correlate = {
  payment: {
    PaymentProcessing: (event) => event.payload.orderId,
    PaymentSettled: (event) => event.payload.orderId,
    PaymentDeclined: (event) => event.payload.orderId,
  },
};
