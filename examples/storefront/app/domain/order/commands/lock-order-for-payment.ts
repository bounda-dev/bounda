import type { Command } from "./+types/lock-order-for-payment";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

export const rejections = ({ state }: Command.RejectionsArgs) => ({
  NotPlaced: `Only placed orders can be locked for payment; this one is ${state.status ?? "new"}`,
});

export const handler = ({ state, events, reject }: Command.HandlerArgs) => {
  if (state.status === "paying") return [];
  if (state.status !== "placed") return reject("NotPlaced");
  return [events.orderLockedForPayment()];
};
