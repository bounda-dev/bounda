import type { Process } from "./+types/index";

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.order.OrderPlaced],
  completedBy: [events.order.OrderFulfilled, events.order.OrderCancelled],
  timeout: process.env.ORDER_TIMEOUT ?? "72h",
});

export const state = ({ z }: Process.StateArgs) =>
  z.object({ autoFulfilled: z.boolean().default(false) });
