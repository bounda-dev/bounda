import { describe, expect, it } from "vitest";
import { compareDecisions, describeDrift, type ExpectedDecisions } from "./compare.ts";

const expected: ExpectedDecisions = {
  countries: ["CA", "JP"],
  organisations: ["European Patent Organisation"],
  scopes: { CA: "(commercial organisations)" },
};

const japan = { kind: "country", code: "JP", name: "Japan", scope: "" } as const;
const canada = {
  kind: "country",
  code: "CA",
  name: "Canada",
  scope: "(commercial organisations)",
} as const;
const patents = { kind: "organisation", name: "European Patent Organisation", scope: "" } as const;

describe("compareDecisions", () => {
  it("finds nothing when the list holds what Bounda does, in any order", () => {
    expect(compareDecisions({ listed: [patents, japan, canada], expected })).toEqual([]);
  });

  it("finds an entry it cannot name", () => {
    expect(
      compareDecisions({
        listed: [canada, japan, patents, { kind: "unknown", text: "Atlantis" }],
        expected,
      }),
    ).toEqual([{ kind: "unknown", text: "Atlantis" }]);
  });

  it("finds a country or an organisation listed twice", () => {
    expect(
      compareDecisions({ listed: [canada, japan, japan, patents, patents], expected }),
    ).toEqual([
      { kind: "duplicate", label: "Japan (JP)" },
      { kind: "duplicate", label: "European Patent Organisation" },
    ]);
  });

  it("finds a new decision, with its scope", () => {
    expect(
      compareDecisions({
        listed: [
          canada,
          japan,
          patents,
          { kind: "country", code: "KE", name: "Kenya", scope: "(private sector)" },
          { kind: "organisation", name: "Space Agency", scope: "" },
        ],
        expected: { ...expected, organisations: [...expected.organisations] },
      }),
    ).toEqual([
      { kind: "added", label: "Kenya (KE)", organisation: false, scope: "(private sector)" },
      { kind: "added", label: "Space Agency", organisation: true, scope: "" },
    ]);
  });

  it("finds a decision no longer listed", () => {
    expect(compareDecisions({ listed: [japan], expected })).toEqual([
      { kind: "removed", label: "Canada (CA)", organisation: false },
      { kind: "removed", label: "European Patent Organisation", organisation: true },
    ]);
  });

  it("finds a scope that changed, appeared or went", () => {
    expect(
      compareDecisions({
        listed: [
          { ...canada, scope: "" },
          { ...japan, scope: "(private sector)" },
          { ...patents, scope: "(staff)" },
        ],
        expected,
      }),
    ).toEqual([
      { kind: "scope", label: "Canada (CA)", listed: "", expected: "(commercial organisations)" },
      { kind: "scope", label: "Japan (JP)", listed: "(private sector)", expected: "" },
      { kind: "scope", label: "European Patent Organisation", listed: "(staff)", expected: "" },
    ]);
  });
});

describe("describeDrift", () => {
  it("writes each drift as a line of a diff that says what to change", () => {
    expect(describeDrift({ kind: "unknown", text: "Atlantis" })).toBe(
      '? "Atlantis": the Commission lists it, and it names no country Bounda knows nor an organisation of ORGANISATIONS; add its name to ALIASES or ORGANISATIONS',
    );
    expect(describeDrift({ kind: "duplicate", label: "Japan (JP)" })).toBe(
      "! Japan (JP): the Commission lists it more than once",
    );
    expect(
      describeDrift({ kind: "added", label: "Kenya (KE)", organisation: false, scope: "" }),
    ).toBe("+ Kenya (KE): the Commission lists it, missing from ADEQUATE_COUNTRIES");
    expect(
      describeDrift({
        kind: "added",
        label: "Kenya (KE)",
        organisation: false,
        scope: "(private)",
      }),
    ).toBe(
      "+ Kenya (KE) (private): the Commission lists it, missing from ADEQUATE_COUNTRIES, its scope from SCOPES",
    );
    expect(
      describeDrift({ kind: "added", label: "Space Agency", organisation: true, scope: "" }),
    ).toBe("+ Space Agency: the Commission lists it, missing from ORGANISATIONS");
    expect(describeDrift({ kind: "removed", label: "Canada (CA)", organisation: false })).toBe(
      "- Canada (CA): in ADEQUATE_COUNTRIES, and the Commission no longer lists it",
    );
    expect(describeDrift({ kind: "removed", label: "Space Agency", organisation: true })).toBe(
      "- Space Agency: in ORGANISATIONS, and the Commission no longer lists it",
    );
    expect(
      describeDrift({ kind: "scope", label: "Canada (CA)", listed: "", expected: "(commercial)" }),
    ).toBe(
      '~ Canada (CA): the Commission writes nothing after its name, SCOPES has "(commercial)"',
    );
    expect(
      describeDrift({ kind: "scope", label: "Japan (JP)", listed: "(private)", expected: "" }),
    ).toBe('~ Japan (JP): the Commission writes "(private)" after its name, SCOPES has nothing');
  });
});
