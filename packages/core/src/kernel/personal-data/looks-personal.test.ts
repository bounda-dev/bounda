import { describe, expect, it } from "vitest";
import { looksPersonal } from "./looks-personal.ts";

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
});
