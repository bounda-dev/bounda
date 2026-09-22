import type { Event } from "./+types/order-placed";

interface LineV1 {
  readonly sku: string;
  readonly quantity: number;
  readonly price: number;
}

interface PayloadV1 {
  readonly customerId: string;
  readonly lines: readonly LineV1[];
}

export const upcasts = [
  (payload: PayloadV1) => ({
    customerId: payload.customerId,
    lines: payload.lines.map(({ sku, quantity, price }) => ({ sku, quantity, unitPrice: price })),
  }),
] satisfies Event.Upcasts;
