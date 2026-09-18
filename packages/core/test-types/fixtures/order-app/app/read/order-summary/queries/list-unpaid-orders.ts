import type { Query } from "./+types/list-unpaid-orders";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ customerId: z.string() });

export const repository = ({ client, customerId }: Query.RepositoryArgs) =>
  client.all("SELECT * FROM order_summary WHERE customer_id = ? AND status = 'placed'", [
    customerId,
  ]);

export const handler = ({ repositoryData }: Query.HandlerArgs) => ({
  orders: repositoryData,
  outstanding: repositoryData.reduce((sum, row) => sum + row.total, 0),
});
