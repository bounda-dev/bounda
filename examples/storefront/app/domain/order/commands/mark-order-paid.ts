import type { Command } from "./+types/mark-order-paid";

export const payload = ({ z, notPersonal }: Command.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.uuid()) });

export const rejections = ({ state }: Command.RejectionsArgs) => ({
  NotOpen: `Only open orders can be paid; this one is ${state.status ?? "new"}`,
});

export const handler = ({ state, events, reject }: Command.HandlerArgs) => {
  if (state.status === "paid" || state.status === "fulfilled") return [];
  if (state.status !== "placed" && state.status !== "paying") return reject("NotOpen");
  return [events.orderPaid()];
};
