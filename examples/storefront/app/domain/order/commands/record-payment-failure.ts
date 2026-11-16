import type { Command } from "./+types/record-payment-failure";

export const payload = ({ z, notPersonal }: Command.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.uuid()), reason: notPersonal(z.string().min(1)) });

export const rejections = ({ state }: Command.RejectionsArgs) => ({
  NotPaying: `Only an order being paid can fail its payment; this one is ${state.status ?? "new"}`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== "paying") return reject("NotPaying");
  return [events.orderPaymentFailed({ reason: command.payload.reason })];
};
