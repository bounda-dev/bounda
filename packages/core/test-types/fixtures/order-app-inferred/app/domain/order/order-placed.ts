import type { Event } from "./+types/order-placed";

export interface Line {
  readonly sku: string;
  readonly quantity: number;
}

export const payload = ({ z, notPersonal }: Event.PayloadArgs) =>
  z.object({
    customerId: notPersonal(z.string()),
    lines: notPersonal(z.array(z.object({ sku: z.string(), quantity: z.int().positive() }))),
  });

export const begin = ({ event }: Event.BeginArgs) => ({
  status: "placed" as const,
  customerId: event.payload.customerId,
  lines: event.payload.lines as readonly Line[],
  placedAt: new Date(event.timestamp),
  reminders: 0,
});
