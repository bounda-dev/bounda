import type { Process } from "./+types/at-timeout";

export const handler = async ({ aggregateId, commands }: Process.DeadlineArgs) => {
  const reason = "not completed in time";
  await commands.recordPaymentFailure({ orderId: aggregateId, reason });
  await commands.cancelOrder({ orderId: aggregateId, reason });
};
