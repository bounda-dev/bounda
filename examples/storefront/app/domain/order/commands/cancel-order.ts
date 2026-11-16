import type { Command } from "./+types/cancel-order";

export const payload = ({ z, notPersonal }: Command.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.uuid()), reason: notPersonal(z.string().min(1)) });

export const rejections = ({ state }: Command.RejectionsArgs) => ({
  PaymentInProgress: "Payment in progress",
  NotCancellable: `Order cannot be cancelled while ${state.status ?? "new"}`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status === "paying") return reject("PaymentInProgress");
  if (state.status !== "placed" && state.status !== "paid") return reject("NotCancellable");
  return [events.orderCancelled({ reason: command.payload.reason })];
};
