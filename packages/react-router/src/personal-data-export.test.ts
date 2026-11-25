import {
  type BoundaClient,
  ConcurrencyError,
  type PersonalDataExportOptions,
  type PersonalDataExportPart,
  ValidationError,
} from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { personalDataExportResponse } from "./personal-data-export.ts";

const header: PersonalDataExportPart = {
  kind: "header",
  header: {
    personId: "ada",
    exportedAt: "2026-01-01T00:00:00.000Z",
    position: 1,
    categories: {},
    rights: [],
    automatedDecisions: [],
    restrictions: [],
    recipients: [],
    transfers: [],
    readModels: [],
  },
};

const clientOf = (
  parts: () => AsyncGenerator<PersonalDataExportPart, void, undefined>,
  asked: string[] = [],
  options: (PersonalDataExportOptions | undefined)[] = [],
): Pick<BoundaClient, "streamPersonalData"> => ({
  streamPersonalData: async (personId, given) => {
    if (personId === "") throw new ValidationError("no person", []);
    asked.push(personId);
    options.push(given);
    return parts();
  },
});

describe("personalDataExportResponse", () => {
  it("answers the export's JSON, streamed, to be saved and never cached", async () => {
    const asked: string[] = [];
    const options: (PersonalDataExportOptions | undefined)[] = [];
    const response = await personalDataExportResponse(
      clientOf(
        async function* () {
          yield header;
        },
        asked,
        options,
      ),
      "ada",
    );
    expect(asked).toEqual(["ada"]);
    expect(options).toEqual([{ includeWithheld: false }]);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="personal-data.json"',
      "cache-control": "no-store",
    });
    expect(JSON.parse(await response.text())).toEqual({
      personId: "ada",
      exportedAt: "2026-01-01T00:00:00.000Z",
      position: 1,
      categories: {},
      rights: [],
      automatedDecisions: [],
      restrictions: [],
      recipients: [],
      redactions: [],
      events: [],
      scheduledCommands: [],
      deadLetters: [],
      subscriberFailures: [],
      answers: [],
      readModels: {},
    });
  });

  it("takes what init adds, its headers over its own", async () => {
    const response = await personalDataExportResponse(
      clientOf(async function* () {
        yield header;
      }),
      "ada",
      {
        status: 203,
        headers: { "content-disposition": 'attachment; filename="ada.json"', "x-request": "r-1" },
      },
    );
    expect(response.status).toBe(203);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="ada.json"');
    expect(response.headers.get("x-request")).toBe("r-1");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("asks for what article 15(4) holds back with includeWithheld, which it leaves out of the response", async () => {
    const options: (PersonalDataExportOptions | undefined)[] = [];
    const response = await personalDataExportResponse(
      clientOf(
        async function* () {
          yield header;
        },
        [],
        options,
      ),
      "ada",
      { includeWithheld: true, status: 203 },
    );
    expect(options).toEqual([{ includeWithheld: true }]);
    expect(response.status).toBe(203);
  });

  it("rejects a refusal before any response, and cuts the body short at a later one", async () => {
    await expect(
      personalDataExportResponse(
        clientOf(async function* () {
          yield header;
        }),
        "",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const response = await personalDataExportResponse(
      clientOf(async function* () {
        yield header;
        throw new ConcurrencyError({
          streamId: "bounda:ada",
          expectedVersion: 1,
          actualVersion: 2,
        });
      }),
      "ada",
    );
    await expect(response.text()).rejects.toBeInstanceOf(ConcurrencyError);
  });
});
