import type { Query } from "./+types/get-order-summary";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ orderId: z.uuid() });

export const repository = ({ table, orderId }: Query.RepositoryArgs) => table.findOne({ orderId });

export const handler = ({ repositoryData }: Query.HandlerArgs) => repositoryData;
