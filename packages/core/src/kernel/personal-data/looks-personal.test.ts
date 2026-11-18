import { describe, expect, it } from "vitest";
import { looksPersonal, looksSpecial } from "./looks-personal.ts";

describe("looksPersonal", () => {
  it.each([
    ["email", "email"],
    ["customerEmail", "email"],
    ["billing_address", "address"],
    ["birthDate", "birth"],
    ["birth_date", "birth"],
    ["birthdate", "birthdate"],
    ["dateOfBirth", "birth"],
    ["firstName", "name"],
    ["firstname", "firstname"],
    ["IPAddress", "ip"],
    ["clientIp", "ip"],
    ["taxId", "taxid"],
    ["customerTaxId", "taxid"],
    ["contact2email", "email"],
    ["_email", "email"],
    ["vat-number", "vatnumber"],
    ["IBAN", "iban"],
    ["licensePlate", "licenseplate"],
    ["latitude", "latitude"],
    ["healthCondition", "health"],
    ["deliveryNote", "note"],
    ["phone2", "phone"],
    ["sexLife", "sex"],
    ["tradeUnion", "tradeunion"],
    ["dnaSample", "dna"],
    ["raceTime", "race"],
    ["criminalRecord", "criminal"],
  ])("reads %s as personal by %s", (field, word) => {
    expect(looksPersonal(field)).toBe(word);
  });

  it.each([
    "orderId",
    "total",
    "sku",
    "invoice",
    "growthRate",
    "latency",
    "cardinality",
    "page",
    "status",
    "quantity",
    "tipAmount",
    "agent_count",
  ])("leaves %s alone", (field) => {
    expect(looksPersonal(field)).toBeNull();
  });

  it.each([
    ["healthCondition", "health", true, false],
    ["medical_history", "medical", true, false],
    ["dnaSample", "dna", true, false],
    ["ethnicOrigin", "ethnic", true, false],
    ["racialOrigin", "racial", true, false],
    ["religiousBeliefs", "religious", true, false],
    ["politicalParty", "political", true, false],
    ["tradeUnion", "tradeunion", true, false],
    ["sexualOrientation", "sexualorientation", true, false],
    ["sexLife", "sexlife", true, false],
    ["criminalRecord", "criminal", false, true],
    ["offenceDate", "offence", false, true],
    ["offense", "offense", false, true],
    ["conviction", "conviction", true, true],
  ])("reads %s as special data by %s", (field, word, special, criminal) => {
    expect(looksSpecial(field)).toEqual([{ word, special, criminal }]);
  });

  it("reads every word that says special data, in order", () => {
    expect(looksSpecial("healthOffence")).toEqual([
      { word: "health", special: true, criminal: false },
      { word: "offence", special: false, criminal: true },
    ]);
    expect(looksSpecial("sexLifeCriminalConviction").map(({ word }) => word)).toEqual([
      "criminal",
      "conviction",
      "sexlife",
    ]);
  });

  it.each([
    "email",
    "raceTime",
    "screenOrientation",
    "sex",
    "gender",
    "fingerprint",
    "healthy",
    "union",
  ])("does not read %s as special data", (field) => {
    expect(looksSpecial(field)).toEqual([]);
  });
});
