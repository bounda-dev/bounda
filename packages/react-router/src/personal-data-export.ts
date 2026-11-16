import { type BoundaClient, personalDataExportJson } from "@bounda-dev/core";

export interface PersonalDataExportResponseFunction {
  (
    client: Pick<BoundaClient, "streamPersonalData">,
    personId: string,
    init?: ResponseInit,
  ): Promise<Response>;
}

/**
 * A person's export as a response a loader returns: the JSON document of
 * `personalDataExportJson`, streamed as it is read, for the browser to save as
 * `personal-data.json`, never cached. A refusal rejects before the response is made, for the
 * route's error handling; one that comes later, as `ConcurrencyError` when the person's data
 * changed while it read, cuts the body short, so what the browser saved is not valid JSON.
 * `init` adds to the response, its headers over these.
 *
 * ```ts
 * export const loader = async ({ context, params }: Route.LoaderArgs) =>
 *   personalDataExportResponse(context.get(bounda).as("dpo"), params.personId);
 * ```
 */
export const personalDataExportResponse: PersonalDataExportResponseFunction = async (
  client,
  personId,
  init = {},
) => {
  const parts = await client.streamPersonalData(personId);
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "content-disposition": 'attachment; filename="personal-data.json"',
    "cache-control": "no-store",
  });
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  return new Response(personalDataExportJson(parts), { ...init, headers });
};
