import type { Process } from "./+types/at-next-reminder";

export const handler = async ({ state, aggregateId, reminders, after }: Process.DeadlineArgs) => {
  await reminders(aggregateId);
  return { ...state, reminders: state.reminders + 1, nextReminder: after("24h") };
};
