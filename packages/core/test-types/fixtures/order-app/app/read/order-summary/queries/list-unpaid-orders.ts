import type { Query } from "./+types/list-unpaid-orders";

export const payload = ({ z }: Query.PayloadArgs) =>
  z.object({ customerId: z.string(), limit: z.int().positive().default(50) });

export const repository = ({ client, customerId, limit }: Query.RepositoryArgs) =>
  client.all("SELECT * FROM order_summary WHERE customer_id = ? AND status = 'placed' LIMIT ?", [
    customerId,
    limit,
  ]);

export const handler = ({ repositoryData }: Query.HandlerArgs) => ({
  orders: repositoryData,
  outstanding: repositoryData.reduce((sum, row) => sum + row.total, 0),
});
