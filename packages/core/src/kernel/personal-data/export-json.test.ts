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
    categories: { default: { basis: null, retention: null, restrictedUntil: null } },
    restrictions: [],
    redactions: [],
    recipients: [],
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
  },
};

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
    const parts = [header(["a"]), failure, failure, answer, row("a", "1")];
    const counted = parts.reduce(countPart, NO_EXPORTED_RECORDS);
    expect(counted).toEqual({
      events: 0,
      scheduledCommands: 0,
      deadLetters: 0,
      subscriberFailures: 2,
      answers: 1,
      readModelRows: 1,
      recipients: 0,
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
