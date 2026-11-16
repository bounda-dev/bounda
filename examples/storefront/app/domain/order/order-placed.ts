import type { Event } from "./+types/order-placed";

export const payload = ({ z, person, notPersonal }: Event.PayloadArgs) =>
  z.object({
    customerId: person(z.string()),
    items: notPersonal(
      z.array(
        z.object({
          productId: z.string(),
          quantity: z.int().positive(),
          price: z.number().positive(),
        }),
      ),
    ),
    total: z.number().positive(),
  });

export const begin = ({ event }: Event.BeginArgs) => ({
  status: "placed" as const,
  customerId: event.payload.customerId,
  items: event.payload.items,
  total: event.payload.total,
  placedAt: event.timestamp,
  confirmationSent: false,
  reminderSent: false,
});
