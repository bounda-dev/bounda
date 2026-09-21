import type { Process } from "./+types/on-timeout";

export const handler = async ({ state, aggregateId, commands }: Process.TimeoutArgs) => {
  await commands.expireRegistration({ userId: aggregateId });
  return state;
};
