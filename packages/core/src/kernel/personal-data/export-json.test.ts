import { describe, expect, it } from "vitest";
import {
  collectPersonalDataExport,
  countPart,
  type ExportedRow,
  NO_EXPORTED_RECORDS,
  type PersonalDataExportHeader,
  type PersonalDataExportPart,
} from "./export.ts";
import { personalDataExportJson } from "./export-json.ts";

const header = (readModels: readonly string[]): PersonalDataExportPart => ({
  kind: "header",
  header: {
    personId: "ana",
    exportedAt: "2026-01-01T00:00:00.000Z",
    position: 3,
    categories: {
      default: {
        basis: null,
        special: null,
        criminal: null,
        purposes: [],
        processedFor: [],
        erasureExemptions: [],
        sources: [],
        retention: null,
        held: false,
        keptUntil: null,
        restrictedUntil: null,
      },
    },
    rights: [{ right: "access", article: "15", categories: null }],
    automatedDecisions: [],
    restrictions: [],
    recipients: [],
    transfers: [],
    readModels,
  } satisfies PersonalDataExportHeader,
});

const row = (readModel: string, key: string): PersonalDataExportPart => ({
  kind: "row",
  readModel,
  row: { key, data: { note: `"${key}"\n` }, categories: { note: "default" }, restricted: [] },
});

const answer: PersonalDataExportPart = {
  kind: "answer",
  answer: {
    idempotencyKey: "k-1",
    expiresAt: "2026-01-02T00:00:00.000Z",
    outcome: { aggregateType: "member", aggregateId: "ana", rejected: "Taken", message: "taken" },
    restricted: [],
    withheld: [],
  },
};

const redaction: PersonalDataExportPart = {
  kind: "redaction",
  redaction: {
    eventId: "r-1",
    at: "2026-01-01T00:00:00.000Z",
    events: [{ id: "e-1", fields: ["note"] }],
  },
};

const failure: PersonalDataExportPart = {
  kind: "subscriberFailure",
  subscriberFailure: {
    subscriber: "projection:notes",
    eventId: "e-1",
    eventType: "MemberNoted",
    errorMessage: "cannot index ana",
    restricted: [],
    withheld: [],
  },
};

const FOR_OTHERS = { reason: "rights-of-others", article: "15(4)" } as const;

// Each part of a kind that can hold a value back, holding one back.
const withheld: readonly PersonalDataExportPart[] = [
  {
    kind: "deadLetter",
    deadLetter: {
      id: "dl-1",
      kind: "policy",
      handler: "member.p",
      errorMessage: null,
      data: {},
      categories: {},
      restricted: [],
      withheld: [{ field: "errorMessage", ...FOR_OTHERS }],
    },
  },
  {
    kind: "subscriberFailure",
    subscriberFailure: {
      subscriber: "projection:notes",
      eventId: "e-1",
      eventType: "MemberNoted",
      restricted: [],
      errorMessage: null,
      withheld: [{ field: "errorMessage", ...FOR_OTHERS }],
    },
  },
  {
    kind: "answer",
    answer: {
      expiresAt: "2026-01-02T00:00:00.000Z",
      restricted: [],
      idempotencyKey: null,
      outcome: null,
      withheld: [
        { field: "idempotencyKey", ...FOR_OTHERS },
        { field: "outcome", ...FOR_OTHERS },
      ],
    },
  },
];

async function* from(
  parts: readonly PersonalDataExportPart[],
): AsyncGenerator<PersonalDataExportPart, void, undefined> {
  yield* parts;
}

const textOf = (parts: readonly PersonalDataExportPart[]) =>
  new Response(personalDataExportJson(from(parts))).text();

describe("personalDataExportJson", () => {
  it("writes what JSON.stringify writes of the collected export, whatever sections are empty", async () => {
    for (const parts of [
      [header([])],
      [header(["a", "b", "c"]), row("b", "1"), row("b", "2")],
      [header(["a", "b"]), answer, row("a", "1"), row("b", "2")],
      [header(["a"]), answer],
      [header(["a"]), failure, failure, answer, row("a", "1")],
      [header([]), redaction],
      [header(["a"]), redaction, redaction, failure, row("a", "1")],
    ]) {
      const collected = await collectPersonalDataExport(from(parts));
      expect(await textOf(parts)).toBe(JSON.stringify(collected, null, 2));
    }
  });

  it("refuses parts out of the order of their sections, of a read model the header does not name, or a second header", async () => {
    await expect(textOf([header(["a"]), row("a", "1"), answer])).rejects.toThrow(
      "A personal data export has a answer out of the order of its sections",
    );
    await expect(textOf([header(["a", "b"]), row("b", "1"), row("a", "2")])).rejects.toThrow(
      "out of the order of its sections",
    );
    await expect(textOf([header(["a"]), row("z", "1")])).rejects.toThrow(
      "out of the order of its sections",
    );
    await expect(textOf([header([]), answer, redaction])).rejects.toThrow(
      "A personal data export has a redaction out of the order of its sections",
    );
    await expect(textOf([header([]), header([])])).rejects.toThrow("a second header");
    await expect(textOf([answer])).rejects.toThrow(
      "A personal data export has a answer before its header",
    );
    await expect(textOf([])).rejects.toThrow("ended before its header");
  });
});

describe("collectPersonalDataExport", () => {
  it("refuses a row of a read model its header does not name, a second header, or none", async () => {
    await expect(collectPersonalDataExport(from([header(["a"]), row("z", "1")]))).rejects.toThrow(
      "A personal data export has a row of z, which its header does not name",
    );
    await expect(collectPersonalDataExport(from([header([]), header([])]))).rejects.toThrow(
      "a second header",
    );
    await expect(collectPersonalDataExport(from([]))).rejects.toThrow("ended before its header");
    const rows: readonly ExportedRow[] | undefined = (
      await collectPersonalDataExport(from([header(["a", "b"]), row("a", "1")]))
    ).readModels.b;
    expect(rows).toEqual([]);
  });
});

describe("the parts of an export", () => {
  it("are read only as the JSON is, never ahead of it", async () => {
    const pulled: string[] = [];
    async function* counted(): AsyncGenerator<PersonalDataExportPart, void, undefined> {
      for (const part of [header([]), answer]) {
        pulled.push(part.kind);
        yield part;
      }
    }
    const reader = personalDataExportJson(counted()).getReader();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pulled).toEqual([]);
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pulled).toEqual(["header"]);
    await reader.cancel();
  });

  it("are counted by kind as they are handed out", () => {
    const parts = [header(["a"]), redaction, failure, failure, answer, row("a", "1")];
    const counted = parts.reduce(countPart, NO_EXPORTED_RECORDS);
    expect(counted).toEqual({
      redactions: 1,
      events: 0,
      scheduledCommands: 0,
      deadLetters: 0,
      subscriberFailures: 2,
      answers: 1,
      readModelRows: 1,
      recipients: 0,
      withheld: 0,
    });
    expect(withheld.reduce(countPart, counted)).toEqual({
      ...counted,
      deadLetters: 1,
      subscriberFailures: 3,
      answers: 2,
      withheld: 3,
    });
    const scheduled: PersonalDataExportPart = {
      kind: "scheduledCommand",
      scheduledCommand: {
        commandId: "c-1",
        type: "Remind",
        executeAt: "2026-01-02T00:00:00.000Z",
        data: {},
        categories: {},
        restricted: [],
      },
    };
    expect(countPart(countPart(counted, scheduled), scheduled).scheduledCommands).toBe(2);
  });
});
