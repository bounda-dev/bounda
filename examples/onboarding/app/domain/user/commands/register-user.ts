import type { Command } from "./+types/register-user";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ userId: z.uuid(), email: z.email(), name: z.string().min(1) });

export const rejections = ({ command }: Command.RejectionsArgs) => ({
  AlreadyRegistered: `User ${command.aggregateId} is already registered`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== undefined) return reject("AlreadyRegistered");
  const { email, name } = command.payload;
  return [events.userRegistered({ email, name })];
};
