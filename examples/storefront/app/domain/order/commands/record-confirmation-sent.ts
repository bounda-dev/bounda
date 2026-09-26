import type { Command } from "./+types/record-confirmation-sent";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

export const handler = ({ state, events }: Command.HandlerArgs) =>
  state.status === undefined || state.confirmationSent !== false ? [] : [events.confirmationSent()];
