import type { Policy } from "./+types/index";

export const delay = "10m";

export const handler = async ({ event, mailer }: Policy.HandlerArgs) => {
  await mailer.send(event.payload.customerId, `order ${event.aggregateId} placed`);
};
