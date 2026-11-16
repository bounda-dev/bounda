import {
  type BoundaClient,
  ConcurrencyError,
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
    restrictions: [],
    redactions: [],
    recipients: [],
    readModels: [],
  },
};

const clientOf = (
  parts: () => AsyncGenerator<PersonalDataExportPart, void, undefined>,
  asked: string[] = [],
): Pick<BoundaClient, "streamPersonalData"> => ({
  streamPersonalData: async (personId) => {
    if (personId === "") throw new ValidationError("no person", []);
    asked.push(personId);
    return parts();
  },
});

describe("personalDataExportResponse", () => {
  it("answers the export's JSON, streamed, to be saved and never cached", async () => {
    const asked: string[] = [];
    const response = await personalDataExportResponse(
      clientOf(async function* () {
        yield header;
      }, asked),
      "ada",
    );
    expect(asked).toEqual(["ada"]);
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
      restrictions: [],
      redactions: [],
      recipients: [],
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
