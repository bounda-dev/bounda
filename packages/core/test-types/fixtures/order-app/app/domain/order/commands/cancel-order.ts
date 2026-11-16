import type { Command } from "./+types/cancel-order";

export const payload = ({ z, notPersonal }: Command.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.uuid()), reason: notPersonal(z.string()) });

export const handler = async ({ command, events, auditLog }: Command.HandlerArgs) => {
  auditLog.record(`cancelled: ${command.payload.reason}`);
  return [events.orderCancelled()];
};
