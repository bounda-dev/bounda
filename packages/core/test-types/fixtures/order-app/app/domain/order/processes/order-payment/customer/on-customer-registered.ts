import type { Process } from "./+types/on-customer-registered";

export const handler = ({ state, event }: Process.HandlerArgs) => ({
  reminders: event.payload.email === null ? state.reminders : state.reminders + 1,
});
