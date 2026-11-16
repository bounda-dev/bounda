import type { Command } from "./+types/fulfill-order";

export const payload = ({ z, notPersonal }: Command.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.uuid()) });

export const rejections = ({ state }: Command.RejectionsArgs) => ({
  NotPaid: `Only paid orders can be fulfilled; this one is ${state.status ?? "new"}`,
});

export const handler = ({ state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== "paid") return reject("NotPaid");
  return [events.orderFulfilled({ customerId: state.customerId, total: state.total })];
};
