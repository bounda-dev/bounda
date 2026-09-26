import type { Process } from "./+types/on-timeout";

export const handler = async ({ state, aggregateId, commands, reminders }: Process.TimeoutArgs) => {
  await reminders.remind(aggregateId);
  await commands.cancelOrder({ orderId: aggregateId, reason: "payment timeout" });
  return { ...state, reminders: state.reminders + 1 };
};
