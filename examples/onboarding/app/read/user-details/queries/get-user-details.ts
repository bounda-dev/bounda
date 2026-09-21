import type { Query } from "./+types/get-user-details";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ userId: z.uuid() });

export const repository = ({ table, userId }: Query.RepositoryArgs) => table.findOne({ userId });

export const handler = ({ repositoryData }: Query.HandlerArgs) => repositoryData;
