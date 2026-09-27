import type { Process } from "./+types/at-timeout";

export const handler = async ({ state, aggregateId, commands }: Process.DeadlineArgs) => {
  await commands.cancelOrder({ orderId: aggregateId, reason: "not fulfilled in time" });
  return state;
};
