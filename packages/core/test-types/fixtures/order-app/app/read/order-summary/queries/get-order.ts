import type { Query } from "./+types/get-order";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ orderId: z.uuid() });

export const repository = ({ client, orderId }: Query.RepositoryArgs) =>
  client.get("SELECT * FROM order_summary WHERE order_id = ?", [orderId]);

export const handler = ({ repositoryData }: Query.HandlerArgs) => repositoryData;
