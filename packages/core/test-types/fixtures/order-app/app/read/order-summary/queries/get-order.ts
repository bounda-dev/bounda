import type { Query } from "./+types/get-order";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ orderId: z.uuid() });

export const repository = ({ client, orderId }: Query.RepositoryArgs) =>
  client.get(
    `SELECT * FROM bounda_rm_order_summary WHERE ${client.unrestricted()} AND order_id = ?`,
    [orderId],
  );

export const handler = ({ repositoryData }: Query.HandlerArgs) => repositoryData;
