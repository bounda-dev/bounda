import type { Command } from "./+types/request-payment";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ paymentId: z.uuid(), orderId: z.uuid(), amount: z.number().positive() });

export const handler = async ({
  command,
  state,
  events,
  gateway,
  idempotencyKey,
}: Command.HandlerArgs) => {
  if (state.status !== "new") return [];
  const { paymentId, orderId, amount } = command.payload;
  const { intentId } = await gateway.createIntent({ paymentId, orderId, amount }, idempotencyKey);
  return [events.paymentRequested({ orderId, amount, intentId })];
};
