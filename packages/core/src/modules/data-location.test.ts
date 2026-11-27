import { describe, expect, it } from "vitest";
import {
  DATA_AREAS,
  isAdequate,
  isDataLocation,
  partialAdequacyOf,
  regimeOf,
} from "./data-location.ts";
import { ADEQUATE_COUNTRIES, COUNTRY_CODES, EEA_COUNTRIES, PARTIAL_ADEQUACY } from "./recipient.ts";

describe("isDataLocation", () => {
  it("knows every country in lower case and every area", () => {
    for (const country of COUNTRY_CODES) expect(isDataLocation(country.toLowerCase())).toBe(true);
    for (const area of DATA_AREAS) expect(isDataLocation(area)).toBe(true);
  });

  it("knows nothing else, nor a country in upper case", () => {
    for (const value of [
      "DE",
      "EU",
      "uk",
      "el",
      "",
      "toString",
      "__proto__",
      1,
      null,
      undefined,
      ["eu"],
      { toString: () => "global" },
    ]) {
      expect(isDataLocation(value), String(value)).toBe(false);
    }
  });
});

describe("regimeOf", () => {
  it("puts every country of the European Economic Area, the EU and the EEA under one regime", () => {
    for (const country of EEA_COUNTRIES) {
      expect(regimeOf(country.toLowerCase() as Lowercase<typeof country>)).toBe("EEA");
    }
    expect(regimeOf("eu")).toBe("EEA");
    expect(regimeOf("eea")).toBe("EEA");
  });

  it("puts every other country under its own, the FedRAMP jurisdictions under the United States", () => {
    expect(regimeOf("us")).toBe("US");
    expect(regimeOf("fedramp")).toBe("US");
    expect(regimeOf("fedramp-high")).toBe("US");
    expect(regimeOf("ch")).toBe("CH");
    expect(regimeOf("gb")).toBe("GB");
    expect(regimeOf("bl")).toBe("BL");
    expect(regimeOf("sj")).toBe("SJ");
  });

  it("puts global under no single one", () => {
    expect(regimeOf("global")).toBe("anywhere");
  });

  it("refuses what is not a location", () => {
    expect(() => regimeOf("DE" as never)).toThrow(new TypeError('"DE" is not a DataLocation'));
  });
});

describe("isAdequate", () => {
  it("answers true for the European Economic Area and every country with an adequacy decision", () => {
    expect(isAdequate("EEA")).toBe(true);
    for (const country of ADEQUATE_COUNTRIES) expect(isAdequate(country)).toBe(true);
  });

  it("answers false for any other country and for anywhere", () => {
    for (const regime of ["IN", "CN", "AU", "SG", "anywhere"] as const) {
      expect(isAdequate(regime), regime).toBe(false);
    }
  });

  it("names no country of the European Economic Area as adequate, which needs no decision", () => {
    const eea: ReadonlySet<string> = new Set(EEA_COUNTRIES);
    expect(ADEQUATE_COUNTRIES.filter((country) => eea.has(country))).toEqual([]);
  });
});

describe("partialAdequacyOf", () => {
  it("names the partial decision of Canada and of the United States, wherever their regime is", () => {
    expect(partialAdequacyOf("CA")).toBe(PARTIAL_ADEQUACY.CA);
    expect(partialAdequacyOf(regimeOf("ca"))).toBe(PARTIAL_ADEQUACY.CA);
    for (const location of ["us", "fedramp", "fedramp-high"] as const) {
      expect(partialAdequacyOf(regimeOf(location)), location).toBe(PARTIAL_ADEQUACY.US);
    }
  });

  it("answers null under a regime adequate as a whole, the European Economic Area, any other and anywhere", () => {
    for (const regime of ["CH", "GB", "JP", "EEA", "IN", "anywhere"] as const) {
      expect(partialAdequacyOf(regime), regime).toBeNull();
    }
  });

  it("holds partial decisions of adequate countries alone, each with a scope of its own", () => {
    const adequate: ReadonlySet<string> = new Set(ADEQUATE_COUNTRIES);
    const partial = Object.entries(PARTIAL_ADEQUACY);
    expect(partial.filter(([country]) => !adequate.has(country))).toEqual([]);
    const scopes = partial.map(([, { scope }]) => scope);
    expect(new Set(scopes).size).toBe(scopes.length);
    for (const [, { celex, decision }] of partial) {
      const [, year, number] = /^3(\d{4})D(\d{4})$/.exec(celex) ?? [];
      expect(decision, celex).toContain(`${year}/${Number(number)}`);
    }
  });
});
