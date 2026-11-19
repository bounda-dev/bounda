import { type BoundaClient, tenantExportJsonLines } from "@bounda-dev/core";

export interface TenantExportResponseFunction {
  (
    client: Pick<BoundaClient, "exportTenant">,
    tenant: string,
    init?: ResponseInit,
  ): Promise<Response>;
}

/**
 * The tenant's export as a response a loader returns, for the controller to take its data back
 * (article 28(3)(g) of the GDPR): the JSON Lines of `tenantExportJsonLines`, streamed as they are
 * read, to be saved as `tenant-export.jsonl`, never cached. A refusal rejects before the response
 * is made, for the route's error handling; one that comes later, as `ConcurrencyError` when the
 * stream moved while it read, cuts the body short of its `end` line, which `readTenantExport`
 * refuses. `init` adds to the response, its headers over these. Guard the route: it hands out
 * every person's data.
 *
 * ```ts
 * export const loader = async ({ context }: Route.LoaderArgs) =>
 *   tenantExportResponse(context.get(bounda).as("operator-7"), "acme");
 * ```
 */
export const tenantExportResponse: TenantExportResponseFunction = async (
  client,
  tenant,
  init = {},
) => {
  const parts = await client.exportTenant(tenant);
  const headers = new Headers({
    "content-type": "application/jsonl; charset=utf-8",
    "content-disposition": 'attachment; filename="tenant-export.jsonl"',
    "cache-control": "no-store",
  });
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  return new Response(tenantExportJsonLines(parts), { ...init, headers });
};
