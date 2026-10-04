import type { Process } from "./+types/at-timeout";

export const handler = async ({ aggregateId, commands }: Process.DeadlineArgs) => {
  await commands.expireRegistration({ userId: aggregateId });
};
