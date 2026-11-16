import type { Command } from "./+types/record-confirmation-sent";

export const payload = ({ z, notPersonal }: Command.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.uuid()) });

export const handler = ({ state, events }: Command.HandlerArgs) =>
  state.status === undefined || state.confirmationSent !== false ? [] : [events.confirmationSent()];
