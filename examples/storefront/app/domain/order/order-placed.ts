import type { Event } from "./+types/order-placed";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({
    customerId: z.string(),
    items: z.array(
      z.object({
        productId: z.string(),
        quantity: z.int().positive(),
        price: z.number().positive(),
      }),
    ),
    total: z.number().positive(),
  });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "placed" as const,
  customerId: event.payload.customerId,
  items: event.payload.items,
  total: event.payload.total,
  placedAt: event.timestamp,
  confirmationSent: false,
  reminderSent: false,
});
