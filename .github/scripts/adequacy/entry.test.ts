import { describe, expect, it } from "vitest";
import { COUNTRY_CODES } from "../../../packages/core/src/modules/recipient.ts";
import { countryName, nameIndex, readEntry } from "./entry.ts";
import { ALIASES, ORGANISATIONS } from "./expected.ts";

const index = nameIndex({
  countries: COUNTRY_CODES,
  aliases: ALIASES,
  organisations: ORGANISATIONS,
});

describe("readEntry", () => {
  it("names a country by its English name, and keeps the words after it as its scope", () => {
    expect(readEntry("Canada (commercial organisations)", index)).toEqual({
      kind: "country",
      code: "CA",
      name: "Canada",
      scope: "(commercial organisations)",
    });
    expect(readEntry("United Kingdom under the GDPR and the LED", index)).toEqual({
      kind: "country",
      code: "GB",
      name: "United Kingdom",
      scope: "under the GDPR and the LED",
    });
    expect(readEntry("Japan", index)).toEqual({
      kind: "country",
      code: "JP",
      name: "Japan",
      scope: "",
    });
  });

  it("reads a name through an alias, a short name, a leading article, case, accents and signs", () => {
    expect(readEntry("Republic of Korea", index)).toMatchObject({ code: "KR" });
    expect(readEntry("South Korea", index)).toMatchObject({ code: "KR" });
    expect(readEntry("UK", index)).toMatchObject({ code: "GB" });
    expect(readEntry("the Faroe Islands", index)).toMatchObject({ code: "FO" });
    expect(readEntry("ISLE OF MAN", index)).toMatchObject({ code: "IM" });
    expect(readEntry("Curacao", index)).toMatchObject({ code: "CW" });
    expect(readEntry("Cote d'Ivoire", index)).toMatchObject({ code: "CI" });
    expect(readEntry("Bosnia and Herzegovina", index)).toMatchObject({ code: "BA" });
  });

  it("parts the name from a scope that follows a comma", () => {
    expect(readEntry("Canada, for commercial organisations", index)).toEqual({
      kind: "country",
      code: "CA",
      name: "Canada",
      scope: "for commercial organisations",
    });
  });

  it("takes the longest name it knows", () => {
    const nested = nameIndex({
      countries: [],
      aliases: { Korea: "KP", "Korea Republic": "KR" },
      organisations: [],
    });
    expect(readEntry("Korea Republic (all)", nested)).toMatchObject({ code: "KR", scope: "(all)" });
    expect(readEntry("Korea (all)", nested)).toMatchObject({ code: "KP", scope: "(all)" });
  });

  it("gives a name two countries share to neither, unless an alias or organisation holds it", () => {
    const namesOf = (code: string): readonly string[] =>
      code === "CG" ? ["Congo", "Republic of the Congo"] : ["Congo", "DR Congo"];
    const shared = nameIndex({ countries: ["CG", "CD"], aliases: {}, organisations: [], namesOf });
    expect(readEntry("Congo", shared)).toEqual({ kind: "unknown", text: "Congo" });
    expect(readEntry("Republic of the Congo", shared)).toMatchObject({ code: "CG" });
    expect(readEntry("DR Congo", shared)).toMatchObject({ code: "CD" });
    const held = nameIndex({
      countries: ["CG", "CD"],
      aliases: { Congo: "CD" },
      organisations: [],
      namesOf,
    });
    expect(readEntry("Congo", held)).toMatchObject({ code: "CD" });
    const organisation = nameIndex({
      countries: ["CG"],
      aliases: {},
      organisations: ["Congo"],
      namesOf,
    });
    expect(readEntry("Congo", organisation)).toEqual({
      kind: "organisation",
      name: "Congo",
      scope: "",
    });
  });

  it("keeps a name a country gives twice", () => {
    const twice = nameIndex({
      countries: ["CG", "CG", "CD"],
      aliases: {},
      organisations: [],
      namesOf: (code) => (code === "CG" ? ["Congo", "Congo"] : ["DR Congo"]),
    });
    expect(readEntry("Congo", twice)).toMatchObject({ code: "CG" });
  });

  it("skips a name that folds to nothing", () => {
    const empty = nameIndex({
      countries: ["CG"],
      aliases: { "—": "CD" },
      organisations: [],
      namesOf: () => ["", "Congo"],
    });
    expect(empty.names.size).toBe(1);
    expect(readEntry("Congo", empty)).toMatchObject({ code: "CG" });
  });

  it("names an organisation by its own name", () => {
    expect(readEntry("European Patent Organisation", index)).toEqual({
      kind: "organisation",
      name: "European Patent Organisation",
      scope: "",
    });
  });

  it("names nothing it does not know", () => {
    expect(readEntry("Atlantis (all of it)", index)).toEqual({
      kind: "unknown",
      text: "Atlantis (all of it)",
    });
    expect(readEntry("the", index)).toEqual({ kind: "unknown", text: "the" });
  });
});

describe("countryName", () => {
  it("is the English name of a country", () => {
    expect(countryName("CH")).toBe("Switzerland");
  });
});
