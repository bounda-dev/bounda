import type { Event } from "./+types/order-placed";

export const payload = ({ z, person, personal }: Event.PayloadArgs) =>
  z.object({
    customerId: person(z.string()),
    total: z.number().positive(),
    deliveryNote: personal(z.string()).optional(),
  });

export const begin = ({ event }: Event.BeginArgs) => ({
  status: "placed" as const,
  customerId: event.payload.customerId,
  total: event.payload.total,
});
