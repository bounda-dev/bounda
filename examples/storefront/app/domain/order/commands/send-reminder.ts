import type { Command } from "./+types/send-reminder";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

export const handler = ({ state, events }: Command.HandlerArgs) =>
  state.status === "placed" && state.reminderSent === false ? [events.reminderSent()] : [];
