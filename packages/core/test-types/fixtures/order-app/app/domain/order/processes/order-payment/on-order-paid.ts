import type { Process } from "./+types/on-order-paid";

export const handler = ({ state, event }: Process.HandlerArgs) => ({
  ...state,
  lastReference: event.payload.reference,
});
