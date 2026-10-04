import type { Command } from "./+types/lock-order-for-payment";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

// Dispatched by the process, which cannot know whether the order moved on meanwhile: any other
// state answers with nothing instead of a DomainError, which would fail the process.
export const handler = ({ state, events }: Command.HandlerArgs) =>
  state.status === "placed" ? [events.orderLockedForPayment()] : [];
