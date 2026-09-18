import type { Event } from "./+types/order-placed";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({
    customerId: z.string(),
    lines: z.array(
      z.object({ sku: z.string(), quantity: z.int().positive(), unitPrice: z.number() }),
    ),
  });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "placed" as const,
  customerId: event.payload.customerId,
  total: event.payload.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
});
