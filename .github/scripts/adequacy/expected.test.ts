import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADEQUATE_COUNTRIES,
  COUNTRY_CODES,
  PARTIAL_ADEQUACY,
} from "../../../packages/core/src/modules/recipient.ts";
import { countryName, nameIndex, readEntry } from "./entry.ts";
import { ALIASES, DECISIONS, ORGANISATIONS, OTHER_ACTS, SCOPES } from "./expected.ts";

const index = nameIndex({
  countries: COUNTRY_CODES,
  aliases: ALIASES,
  organisations: ORGANISATIONS,
});

const codesOf = (names: readonly string[]): readonly string[] =>
  names.map((name) => {
    const entry = readEntry(name, index);
    return entry.kind === "country" && entry.scope === "" ? entry.code : `unknown: ${name}`;
  });

const namesIn = (list: string): readonly string[] =>
  list.split(/,\s*(?:and\s+)?|\s+and\s+/).map((name) => name.trim());

const flat = (source: string): string => source.replace(/\n\s*\*\s*/g, " ").replace(/\s+/g, " ");

// Where the list is written in prose: the reference and the JSDoc of `ADEQUATE_COUNTRIES`.
const configuration = flat(
  readFileSync(
    new URL("../../../docs/src/content/docs/reference/configuration.md", import.meta.url),
    "utf8",
  ),
);
const recipient = flat(
  readFileSync(new URL("../../../packages/core/src/modules/recipient.ts", import.meta.url), "utf8"),
);

const partial = ADEQUATE_COUNTRIES.filter((code) => SCOPES[code]?.startsWith("("));

describe("what the check expects", () => {
  it("reads every country of ADEQUATE_COUNTRIES back from its English name", () => {
    expect(codesOf(ADEQUATE_COUNTRIES.map(countryName))).toEqual(ADEQUATE_COUNTRIES);
  });

  it("reads every alias and organisation back as itself", () => {
    for (const [name, code] of Object.entries(ALIASES)) {
      expect(readEntry(name, index)).toMatchObject({ kind: "country", code, scope: "" });
    }
    for (const name of ORGANISATIONS) {
      expect(readEntry(name, index)).toEqual({ kind: "organisation", name, scope: "" });
    }
  });

  it("is what the reference lists", () => {
    const list = /adopted an adequacy decision for \(([^)]+), as of [A-Z][a-z]+ \d{4}\)/.exec(
      configuration,
    )?.[1];
    expect(list).toBeDefined();
    expect([...codesOf(namesIn(list ?? ""))].sort()).toEqual([...ADEQUATE_COUNTRIES].sort());
  });

  it("is what PARTIAL_ADEQUACY, the reference and the JSDoc call partial decisions", () => {
    expect(partial).toEqual(Object.keys(PARTIAL_ADEQUACY).sort());
    for (const source of [configuration, recipient]) {
      const list = /The decisions for (.+?) cover some recipients alone/.exec(source)?.[1];
      expect(list).toBeDefined();
      expect(codesOf(namesIn(list ?? ""))).toEqual(partial);
    }
  });

  it("names one decision of its own for every entry, none of them an act of OTHER_ACTS", () => {
    const celexes = Object.values(DECISIONS);
    expect(Object.keys(DECISIONS).sort()).toEqual([...ADEQUATE_COUNTRIES, ...ORGANISATIONS].sort());
    expect(new Set(celexes).size).toBe(celexes.length);
    for (const celex of [...celexes, ...Object.keys(OTHER_ACTS)]) {
      expect(celex).toMatch(/^3\d{4}D\d{4}$/);
    }
    expect(celexes.filter((celex) => Object.hasOwn(OTHER_ACTS, celex))).toEqual([]);
    for (const [country, { celex }] of Object.entries(PARTIAL_ADEQUACY)) {
      expect(DECISIONS[country as keyof typeof DECISIONS]).toBe(celex);
    }
  });
});
