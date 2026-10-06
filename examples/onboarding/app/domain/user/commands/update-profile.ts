import type { Command } from "./+types/update-profile";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ userId: z.uuid(), name: z.string().min(1) });

export const rejections = ({ command }: Command.RejectionsArgs) => ({
  NotUpdatable: `User ${command.aggregateId} cannot be updated`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== "registered" && state.status !== "active") return reject("NotUpdatable");
  if (state.name === command.payload.name) return [];
  return [events.profileUpdated({ name: command.payload.name })];
};
