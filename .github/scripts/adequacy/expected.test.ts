import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADEQUATE_COUNTRIES, COUNTRY_CODES } from "../../../packages/core/src/modules/recipient.ts";
import { countryName, nameIndex, readEntry } from "./entry.ts";
import { ALIASES, ORGANISATIONS, SCOPES } from "./expected.ts";

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

  it("is what the reference and the JSDoc call partial decisions", () => {
    for (const source of [configuration, recipient]) {
      const list = /The decisions for (.+?) cover some organisations alone/.exec(source)?.[1];
      expect(list).toBeDefined();
      expect(codesOf(namesIn(list ?? ""))).toEqual(partial);
    }
  });
});
