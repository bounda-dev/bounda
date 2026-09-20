import type { Query } from "./+types/list-orders-by-customer";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ customerId: z.string().min(1) });

export const repository = ({ client, customerId }: Query.RepositoryArgs) =>
  client.all(
    "SELECT * FROM bounda_order_summary WHERE customer_id = ? ORDER BY placed_at, order_id",
    [customerId],
  );

export const handler = ({ repositoryData }: Query.HandlerArgs) => ({
  orders: repositoryData,
  open: repositoryData.filter((order) => order.status === "placed" || order.status === "confirmed"),
  spent: repositoryData
    .filter((order) => order.status === "fulfilled")
    .reduce((sum, order) => sum + order.total, 0),
});
