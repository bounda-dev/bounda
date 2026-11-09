import type { GlobalStream, ReadEventsArgs, StoredEvent } from "@bounda-dev/core";
import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import { parseForgetList, parseSince, readForgotten } from "./forgotten.ts";

const event = (
  position: number,
  aggregateType: string,
  aggregateId: string,
  type: string,
  timestamp = "2026-11-01T00:00:00.000Z",
  payload: unknown = {},
): StoredEvent => ({
  id: `e-${position}`,
  aggregateType,
  aggregateId,
  version: 1,
  type,
  payload,
  timestamp,
  metadata: { correlationId: "c", causationId: "c", depth: 0, schemaVersion: 1, system: false },
  person: null,
  position,
});

const streamOf = (events: readonly StoredEvent[]) => {
  const reads: ReadEventsArgs[] = [];
  const stream: GlobalStream = {
    read: async (args = {}) => {
      reads.push(args);
      const { after = 0, limit = 100 } = args;
      return events.filter(({ position }) => position > after).slice(0, limit);
    },
  };
  return { stream, reads };
};

describe("parseSince", () => {
  it("takes a whole number as a position and a date as a time", () => {
    expect(parseSince(" 42 ")).toEqual({ kind: "position", value: 42 });
    expect(parseSince("2026-11-01")).toEqual({ kind: "date", value: Date.UTC(2026, 10, 1) });
    expect(parseSince(" 2026-11-01T03:00:00Z ")).toEqual({
      kind: "date",
      value: Date.UTC(2026, 10, 1, 3),
    });
  });

  it("refuses anything else", () => {
    for (const value of ["", "yesterday", "-3", "4.5", "2026-13-45"]) {
      expect(() => parseSince(value)).toThrow(InvalidArgumentError);
    }
  });
});

describe("readForgotten", () => {
  it("keeps the runtime's PersonalDataForgotten after a position, reading every page", async () => {
    const events = Array.from({ length: 1_003 }, (_, index) =>
      event(index + 1, "order", `o-${index}`, "OrderPlaced"),
    );
    events.push(
      event(1_004, "bounda", "c-1", "ProcessingRestricted"),
      event(1_005, "order", "o-x", "PersonalDataForgotten"),
      event(1_006, "bounda", "c-1", "PersonalDataForgotten", "2026-11-02T00:00:00.000Z", {
        reason: "retention",
        fingerprints: ["k-1"],
      }),
      event(1_007, "bounda", "c-2", "PersonalDataForgotten", "1970-01-01T00:00:00.001Z"),
      event(1_008, "bounda", "c-3", "PersonalDataForgotten", undefined, {
        reason: "restored",
        fingerprints: [1],
      }),
    );
    const { stream, reads } = streamOf([
      event(0, "bounda", "c-0", "PersonalDataForgotten"),
      ...events,
    ]);
    const lines = await readForgotten({ events: stream, since: { kind: "position", value: 2 } });
    expect(lines).toStrictEqual([
      {
        personId: "c-1",
        eventId: "e-1006",
        forgottenAt: "2026-11-02T00:00:00.000Z",
        reason: "retention",
        fingerprints: ["k-1"],
      },
      {
        personId: "c-2",
        eventId: "e-1007",
        forgottenAt: "1970-01-01T00:00:00.001Z",
        reason: "requested",
      },
      {
        personId: "c-3",
        eventId: "e-1008",
        forgottenAt: "2026-11-01T00:00:00.000Z",
        reason: "requested",
      },
    ]);
    expect(reads).toEqual([
      { after: 2, limit: 1_000 },
      { after: 1_002, limit: 1_000 },
    ]);
  });

  it("reads the whole stream for a date, keeping what came at it or later", async () => {
    const { stream, reads } = streamOf([
      event(1, "bounda", "c-1", "PersonalDataForgotten", "2026-10-31T23:59:59.999Z"),
      event(2, "bounda", "c-2", "PersonalDataForgotten", "2026-11-01T00:00:00.000Z"),
      event(3, "bounda", "c-3", "PersonalDataForgotten", "2026-11-03T00:00:00.000Z"),
    ]);
    const since = parseSince("2026-11-01");
    expect(
      (await readForgotten({ events: stream, since })).map(({ personId }) => personId),
    ).toEqual(["c-2", "c-3"]);
    expect(reads).toEqual([{ after: 0, limit: 1_000 }]);
  });
});

describe("parseForgetList", () => {
  it("reads entries, bare ids and blank lines", () => {
    expect(
      parseForgetList(
        '{"personId":"c-1","eventId":"e-1","forgottenAt":"x"}\r\n\n  c-2  \n{"personId":"c-3"}\n',
      ),
    ).toStrictEqual([
      { personId: "c-1", eventId: "e-1", forgottenAt: "x" },
      { personId: "c-2" },
      { personId: "c-3" },
    ]);
  });

  it("reads back what bounda forgotten prints: the reason and the keys a forgetting names", () => {
    expect(
      parseForgetList(
        '{"personId":"c-1","eventId":"e-1","forgottenAt":"t","reason":"retention","fingerprints":["k-1"]}\n{"personId":"c-2","reason":"requested","fingerprints":[]}',
      ),
    ).toStrictEqual([
      {
        personId: "c-1",
        eventId: "e-1",
        forgottenAt: "t",
        reason: "retention",
        fingerprints: ["k-1"],
      },
      { personId: "c-2", reason: "requested", fingerprints: [] },
    ]);
  });

  it("refuses a line whose fields are not what bounda forgotten prints, naming it", () => {
    for (const line of [
      '{"personId":3}',
      '{"personId":"c-1","eventId":3}',
      '{"personId":"c-1","forgottenAt":3}',
      '{"personId":"c-1","reason":"restored"}',
      '{"personId":"c-1","reason":"toString"}',
      '{"personId":"c-1","fingerprints":"k-1"}',
      '{"personId":"c-1","fingerprints":["k-1",2]}',
    ]) {
      expect(() => parseForgetList(`c-0\n${line}`)).toThrow(
        'line 2 needs a "personId" string; "eventId" and "forgottenAt" only as strings, "reason" only as "requested" or "retention", and "fingerprints" only as a list of strings',
      );
    }
    expect(() => parseForgetList("{not json")).toThrow("line 1 is neither a person's id nor JSON");
  });
});
