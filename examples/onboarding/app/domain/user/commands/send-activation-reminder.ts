import type { Command } from "./+types/send-activation-reminder";

// Scheduled days ahead with the address it goes to, so the stored command holds personal data:
// marked, it waits encrypted, and forgetting the user cancels it.
export const payload = ({ z, personal }: Command.PayloadArgs) =>
  z.object({
    userId: z.uuid(),
    email: personal(z.email()),
    name: personal(z.string().min(1)),
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
  await emailSender({ template: "activation-reminder", to: email, name, idempotencyKey });
  return [events.activationReminderSent()];
};
