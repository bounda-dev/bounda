import type { Process } from "./+types/on-timeout";

export const handler = async ({ state, aggregateId, commands }: Process.TimeoutArgs) => {
  await commands.cancelOrder({ orderId: aggregateId, reason: "payment timeout" });
  return { ...state, reminders: state.reminders + 1 };
};
