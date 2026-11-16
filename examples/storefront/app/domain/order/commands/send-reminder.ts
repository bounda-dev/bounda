import type { Command } from "./+types/send-reminder";

export const payload = ({ z, notPersonal }: Command.PayloadArgs) =>
  z.object({ orderId: notPersonal(z.uuid()) });

export const handler = ({ state, events }: Command.HandlerArgs) =>
  state.status === "placed" && state.reminderSent === false ? [events.reminderSent()] : [];
