import type { Command } from "./+types/send-activation-reminder";

// Scheduled days ahead with the address it goes to, so the stored command holds personal data:
// marked, it waits encrypted, and forgetting the user cancels it.
export const payload = ({ z, personal, person }: Command.PayloadArgs) =>
  z.object({
    userId: person(z.uuid()),
    email: personal(z.email(), { category: "account" }),
    name: personal(z.string().min(1), { category: "account" }),
  });

export const handler = async ({
  command,
  state,
  events,
  emailSender,
  idempotencyKey,
}: Command.HandlerArgs) => {
  if (state.status !== "registered" || state.activationReminderSent !== false) return [];
  const { email, name } = command.payload;
  await emailSender.send({
    template: "activation-reminder",
    userId: command.payload.userId,
    to: email,
    name,
    idempotencyKey,
  });
  return [events.activationReminderSent()];
};
