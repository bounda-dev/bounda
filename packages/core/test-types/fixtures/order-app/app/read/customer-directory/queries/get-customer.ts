import type { Query } from "./+types/get-customer";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ customerId: z.uuid() });

export const repository = ({ table, customerId }: Query.RepositoryArgs) =>
  table.findOne({ customerId });

export const handler = ({ repositoryData }: Query.HandlerArgs) => repositoryData;
