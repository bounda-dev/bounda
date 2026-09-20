import type { Event } from "./+types/order-placed";

export interface Line {
  readonly sku: string;
  readonly quantity: number;
}

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({
    customerId: z.string(),
    lines: z.array(z.object({ sku: z.string(), quantity: z.int().positive() })),
  });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "placed" as const,
  customerId: event.payload.customerId,
  lines: event.payload.lines as readonly Line[],
  placedAt: new Date(event.timestamp),
});
