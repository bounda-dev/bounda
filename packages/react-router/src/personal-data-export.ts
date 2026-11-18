import {
  type BoundaClient,
  type PersonalDataExportOptions,
  personalDataExportJson,
} from "@bounda-dev/core";

/**
 * What `personalDataExportResponse` adds to the response, and what it asks of the export.
 */
export interface PersonalDataExportResponseInit extends ResponseInit, PersonalDataExportOptions {}

export interface PersonalDataExportResponseFunction {
  (
    client: Pick<BoundaClient, "streamPersonalData">,
    personId: string,
    init?: PersonalDataExportResponseInit,
  ): Promise<Response>;
}

/**
 * A person's export as a response a loader returns: the JSON document of
 * `personalDataExportJson`, streamed as it is read, for the browser to save as
 * `personal-data.json`, never cached. A refusal rejects before the response is made, for the
 * route's error handling; one that comes later, as `ConcurrencyError` when the person's data
 * changed while it read, cuts the body short, so what the browser saved is not valid JSON.
 * `init` adds to the response, its headers over these; its `includeWithheld` opens what article
 * 15(4) holds back, for a controller who weighs it, never for the person's own download.
 *
 * ```ts
 * export const loader = async ({ context, params }: Route.LoaderArgs) =>
 *   personalDataExportResponse(context.get(bounda).as("dpo"), params.personId);
 * ```
 */
export const personalDataExportResponse: PersonalDataExportResponseFunction = async (
  client,
  personId,
  { includeWithheld, ...init } = {},
) => {
  const parts = await client.streamPersonalData(personId, {
    includeWithheld: includeWithheld === true,
  });
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "content-disposition": 'attachment; filename="personal-data.json"',
    "cache-control": "no-store",
  });
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  return new Response(personalDataExportJson(parts), { ...init, headers });
};
