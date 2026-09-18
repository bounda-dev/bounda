import type { Query } from "./+types/customer-overview";

export const payload = ({ z }: Query.PayloadArgs) =>
  z.object({ customerId: z.string(), lastOrderId: z.uuid() });

export const handler = async ({ query, queries }: Query.HandlerArgs) => {
  const unpaid = await queries.listUnpaidOrders({ customerId: query.payload.customerId });
  const last = await queries.getOrder({ orderId: query.payload.lastOrderId });
  return {
    unpaidCount: unpaid.orders.length,
    outstanding: unpaid.outstanding,
    lastStatus: last?.status ?? null,
  };
};
