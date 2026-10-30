import type { Event } from "./+types/order-placed";

export const payload = ({ z, personal, person }: Event.PayloadArgs) =>
  z.object({
    customerId: person(z.string()),
    lines: z.array(
      z.object({ sku: z.string(), quantity: z.int().positive(), unitPrice: z.number() }),
    ),
    note: personal(z.string()).optional(),
  });

export const evolve = ({ state, event }: Event.EvolveArgs) => ({
  ...state,
  status: "placed" as const,
  customerId: event.payload.customerId,
  total: event.payload.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
});
