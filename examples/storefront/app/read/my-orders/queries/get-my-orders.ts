import type { Query } from "./+types/get-my-orders";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ customerId: z.string().min(1) });

export const repository = ({ table, customerId }: Query.RepositoryArgs) =>
  table.findMany({ where: { customerId }, orderBy: { field: "total", direction: "desc" } });

export const handler = ({ repositoryData }: Query.HandlerArgs) => repositoryData;
