import type { Process } from "./+types/at-timeout";

export const handler = async ({
  state,
  aggregateId,
  commands,
  reminders,
}: Process.DeadlineArgs) => {
  await reminders(aggregateId);
  await commands.cancelOrder({ orderId: aggregateId, reason: "payment timeout" });
  return { reminders: state.reminders + 1 };
};
