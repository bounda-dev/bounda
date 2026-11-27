import { describe, expect, it } from "vitest";
import type { ActInForce, ActStatus } from "./eurlex.ts";
import {
  compareInForce,
  describeInForceDrift,
  describeInForceNotice,
  ENDING_WITHIN_DAYS,
  type InForceExpected,
} from "./in-force.ts";

const expected: InForceExpected = {
  decisions: { CH: "32000D0518", US: "32023D1795", "European Patent Organisation": "32025D1382" },
  otherActs: { "32021D1773": "the United Kingdom under Directive (EU) 2016/680" },
};

const today = "2026-11-26";

const open = (celex: string): ActStatus => ({ celex, inForce: true, endOfValidity: "9999-12-31" });

const act = (celex: string): ActInForce => ({ celex, title: `Decision ${celex}` });

const statuses = [open("32000D0518"), open("32023D1795"), open("32025D1382")];
const actsInForce = [act("32000D0518"), act("32023D1795"), act("32025D1382"), act("32021D1773")];

describe("compareInForce", () => {
  it("finds nothing when every decision is in force and every act in force is known", () => {
    expect(compareInForce({ statuses, actsInForce, expected, today })).toEqual({
      drifts: [],
      notices: [],
    });
  });

  it("finds a decision EUR-Lex has no longer in force, whatever its end, or whose validity ended", () => {
    const { drifts } = compareInForce({
      statuses: [
        { celex: "32000D0518", inForce: false, endOfValidity: "2000-07-26" },
        { celex: "32023D1795", inForce: true, endOfValidity: today },
        { celex: "32025D1382", inForce: false, endOfValidity: null },
      ],
      actsInForce: [],
      expected,
      today,
    });
    expect(drifts).toEqual([
      {
        kind: "ended",
        label: "Switzerland (CH)",
        organisation: false,
        celex: "32000D0518",
        endedOn: null,
      },
      {
        kind: "ended",
        label: "United States (US)",
        organisation: false,
        celex: "32023D1795",
        endedOn: today,
      },
      {
        kind: "ended",
        label: "European Patent Organisation",
        organisation: true,
        celex: "32025D1382",
        endedOn: null,
      },
    ]);
  });

  it("finds a decision EUR-Lex has no act for", () => {
    expect(
      compareInForce({ statuses: statuses.slice(1), actsInForce, expected, today }).drifts,
    ).toEqual([{ kind: "missing", label: "Switzerland (CH)", celex: "32000D0518" }]);
  });

  it("finds an act in force that reads as an adequacy decision Bounda does not know", () => {
    expect(
      compareInForce({
        statuses,
        actsInForce: [...actsInForce, act("32027D0001")],
        expected,
        today,
      }).drifts,
    ).toEqual([{ kind: "unknown", celex: "32027D0001", title: "Decision 32027D0001" }]);
  });

  it("finds a decision in force the query of acts in force no longer finds, as it went blind", () => {
    expect(
      compareInForce({ statuses, actsInForce: actsInForce.slice(1), expected, today }).drifts,
    ).toEqual([{ kind: "unseen", label: "Switzerland (CH)", celex: "32000D0518" }]);
  });

  it("notices a decision whose validity ends within ENDING_WITHIN_DAYS, and no later one", () => {
    const ending = (endOfValidity: string): ActStatus => ({
      celex: "32023D1795",
      inForce: true,
      endOfValidity,
    });
    const noticed = (endOfValidity: string) =>
      compareInForce({
        statuses: [open("32000D0518"), ending(endOfValidity), open("32025D1382")],
        actsInForce,
        expected,
        today,
      });
    expect(ENDING_WITHIN_DAYS).toBe(180);
    expect(noticed("2027-05-25")).toEqual({
      drifts: [],
      notices: [
        {
          label: "United States (US)",
          organisation: false,
          celex: "32023D1795",
          endOfValidity: "2027-05-25",
          days: ENDING_WITHIN_DAYS,
        },
      ],
    });
    expect(noticed("2026-11-27").notices).toMatchObject([{ days: 1 }]);
    expect(noticed("2027-05-26").notices).toEqual([]);
    expect(
      compareInForce({
        statuses: [open("32000D0518"), { ...ending(""), endOfValidity: null }, open("32025D1382")],
        actsInForce,
        expected,
        today,
      }),
    ).toEqual({ drifts: [], notices: [] });
  });
});

describe("describeInForceDrift", () => {
  it("says what to change for each drift", () => {
    expect(
      describeInForceDrift({ kind: "missing", label: "Switzerland (CH)", celex: "32000D0518" }),
    ).toBe(
      "- Switzerland (CH) 32000D0518: EUR-Lex has no act 32000D0518; check its CELEX number in DECISIONS",
    );
    expect(
      describeInForceDrift({
        kind: "ended",
        label: "United States (US)",
        organisation: false,
        celex: "32023D1795",
        endedOn: null,
      }),
    ).toBe(
      "- United States (US) 32023D1795: EUR-Lex has the decision no longer in force; drop it from ADEQUATE_COUNTRIES, and from PARTIAL_ADEQUACY if it is there, or, if another decision replaced it, name that one in DECISIONS",
    );
    expect(
      describeInForceDrift({
        kind: "ended",
        label: "European Patent Organisation",
        organisation: true,
        celex: "32025D1382",
        endedOn: "2031-12-27",
      }),
    ).toBe(
      "- European Patent Organisation 32025D1382: EUR-Lex ends the decision's validity on 2031-12-27; drop it from ORGANISATIONS, or, if another decision replaced it, name that one in DECISIONS",
    );
    expect(
      describeInForceDrift({ kind: "unseen", label: "Switzerland (CH)", celex: "32000D0518" }),
    ).toBe(
      "? Switzerland (CH) 32000D0518: EUR-Lex has the decision in force, and ACTS_IN_FORCE_QUERY no longer finds it, so it could miss a new decision too; fix the query in .github/scripts/adequacy/eurlex.ts",
    );
    expect(describeInForceDrift({ kind: "unknown", celex: "32027D0001", title: "On India" })).toBe(
      '+ 32027D0001 "On India": EUR-Lex has it in force and it reads as an adequacy decision, which neither DECISIONS nor OTHER_ACTS names; read it, then add it to DECISIONS, with ADEQUATE_COUNTRIES, if it is a decision of the list, or to OTHER_ACTS with what it does',
    );
  });
});

describe("describeInForceNotice", () => {
  it("says when the decision ends and what to do without a renewal", () => {
    expect(
      describeInForceNotice({
        label: "European Patent Organisation",
        organisation: true,
        celex: "32025D1382",
        endOfValidity: "2027-01-01",
        days: 36,
      }),
    ).toBe(
      "European Patent Organisation 32025D1382: EUR-Lex ends the decision's validity on 2027-01-01, in 36 days; without a renewal by then, drop it from ORGANISATIONS",
    );
    expect(
      describeInForceNotice({
        label: "United Kingdom (GB)",
        organisation: false,
        celex: "32021D1772",
        endOfValidity: "2031-12-27",
        days: 30,
      }),
    ).toBe(
      "United Kingdom (GB) 32021D1772: EUR-Lex ends the decision's validity on 2031-12-27, in 30 days; without a renewal by then, drop it from ADEQUATE_COUNTRIES, and from PARTIAL_ADEQUACY if it is there",
    );
  });
});
