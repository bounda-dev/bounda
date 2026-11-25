import { describe, expect, it } from "vitest";
import { DATA_AREAS, isAdequate, isDataLocation, regimeOf } from "./data-location.ts";
import { ADEQUATE_COUNTRIES, COUNTRY_CODES, EEA_COUNTRIES } from "./recipient.ts";

describe("isDataLocation", () => {
  it("knows every country in lower case and every area", () => {
    for (const country of COUNTRY_CODES) expect(isDataLocation(country.toLowerCase())).toBe(true);
    for (const area of DATA_AREAS) expect(isDataLocation(area)).toBe(true);
  });

  it("knows nothing else, nor a country in upper case", () => {
    for (const value of ["DE", "EU", "uk", "el", "", "toString", "__proto__", 1, null, undefined]) {
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
