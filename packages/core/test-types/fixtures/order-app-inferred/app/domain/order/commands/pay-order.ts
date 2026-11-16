import type { Command } from "./+types/pay-order";

export const payload = ({ z, notPersonal }: Command.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.uuid()), method: z.enum(["card", "transfer"]) });

export const rejections = ({ state }: Command.RejectionsArgs) => ({
  NotPlaced: `Only placed orders can be paid; this one is ${state.status}`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== "placed") return reject("NotPlaced");
  return [events.orderPaid({ method: command.payload.method })];
};
