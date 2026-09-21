import type { Query } from "./+types/list-users";

export const payload = ({ z }: Query.PayloadArgs) =>
  z.object({
    page: z.int().positive().default(1),
    pageSize: z.int().positive().max(100).default(20),
  });

export const repository = async ({ table, page, pageSize }: Query.RepositoryArgs) => {
  const [users, total, active] = await Promise.all([
    table.findMany({
      orderBy: { field: "registeredAt", direction: "desc" },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    table.count(),
    table.count({ status: "active" }),
  ]);
  return { users, total, active };
};

export const handler = ({ query, repositoryData }: Query.HandlerArgs) => ({
  users: repositoryData.users,
  total: repositoryData.total,
  active: repositoryData.active,
  page: query.payload.page,
  pageSize: query.payload.pageSize,
  pages: Math.max(1, Math.ceil(repositoryData.total / query.payload.pageSize)),
});
