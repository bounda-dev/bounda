import type { Command } from "./+types/register-user";

export const payload = ({ z, personal, person }: Command.PayloadArgs) =>
  z.object({
    userId: person(z.uuid()),
    email: personal(z.email(), { category: "account" }),
    name: personal(z.string().min(1), { category: "account" }),
  });

export const rejections = ({ command }: Command.RejectionsArgs) => ({
  AlreadyRegistered: `User ${command.aggregateId} is already registered`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== undefined) return reject("AlreadyRegistered");
  const { email, name } = command.payload;
  return [events.userRegistered({ email, name })];
};
