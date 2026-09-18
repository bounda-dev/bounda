import type { Command } from "./+types/index";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), reason: z.string() });

export const handler = async ({ command, events, auditLog }: Command.HandlerArgs) => {
  auditLog.record(`cancelled: ${command.payload.reason}`);
  return [events.orderCancelled()];
};
