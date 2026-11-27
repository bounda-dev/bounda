import { describe, expect, it } from "vitest";
import { PARTIAL_ADEQUACY } from "../../modules/recipient.ts";
import { forgottenReasonOf, ledgerDisclosureOf } from "./forget-ledger.ts";

describe("forgottenReasonOf", () => {
  it("reads back every reason Bounda knows, and anything else as requested", () => {
    for (const reason of ["requested", "objection", "retention"] as const) {
      expect(forgottenReasonOf(reason)).toBe(reason);
    }
    for (const stored of [undefined, null, "", "whim", 1]) {
      expect(forgottenReasonOf(stored)).toBe("requested");
    }
  });
});

describe("ledgerDisclosureOf", () => {
  const identity = {
    port: "customer.mailer",
    recipient: "Mailchimp",
    kind: "processor",
    country: "US",
  };
  const transfer = {
    safeguard: "standard-contractual-clauses",
    article: "46(2)(c)",
    regime: "US",
    partialAdequacy: null,
  } as const;

  it("reads a disclosure with its transfer as it was kept, whatever the lists say now", () => {
    const kept = { ...identity, transfer: { ...transfer, regime: "EEA" }, category: "contact" };
    expect(ledgerDisclosureOf({ ...kept, extra: 1 })).toEqual(kept);
    // A partial decision as it was kept, though a later one would read otherwise.
    const decision = { ...PARTIAL_ADEQUACY.US, condition: "as kept" };
    const partial = {
      ...identity,
      transfer: { safeguard: "adequacy", article: "45", regime: "US", partialAdequacy: decision },
      category: "contact",
    };
    expect(
      ledgerDisclosureOf({
        ...partial,
        transfer: { ...partial.transfer, partialAdequacy: { ...decision, extra: 1 } },
      }),
    ).toEqual(partial);
    expect(
      ledgerDisclosureOf({ ...identity, country: "FR", transfer: null, category: "c" }),
    ).toEqual({ ...identity, country: "FR", transfer: null, category: "c" });
  });

  it("derives the transfer of a disclosure written before it was kept from its country and safeguard", () => {
    expect(
      ledgerDisclosureOf({
        ...identity,
        safeguard: "standard-contractual-clauses",
        category: "contact",
      }),
    ).toEqual({ ...identity, transfer, category: "contact" });
    expect(ledgerDisclosureOf({ ...identity, safeguard: "adequacy", category: "contact" })).toEqual(
      {
        ...identity,
        transfer: {
          safeguard: "adequacy",
          article: "45",
          regime: "US",
          partialAdequacy: PARTIAL_ADEQUACY.US,
        },
        category: "contact",
      },
    );
    expect(
      ledgerDisclosureOf({
        ...identity,
        country: "CH",
        safeguard: "adequacy",
        category: "contact",
      }),
    ).toEqual({
      ...identity,
      country: "CH",
      transfer: { safeguard: "adequacy", article: "45", regime: "CH", partialAdequacy: null },
      category: "contact",
    });
    for (const safeguard of [null, undefined]) {
      expect(ledgerDisclosureOf({ ...identity, country: "FR", safeguard, category: "c" })).toEqual({
        ...identity,
        country: "FR",
        transfer: null,
        category: "c",
      });
    }
  });

  it("reads nothing else", () => {
    const whole = { ...identity, transfer, category: "contact" };
    for (const field of ["port", "recipient", "kind", "country", "category"]) {
      expect(ledgerDisclosureOf({ ...whole, [field]: 1 })).toBeNull();
      const { [field as keyof typeof whole]: _, ...without } = whole;
      expect(ledgerDisclosureOf(without)).toBeNull();
    }
    for (const stored of [null, undefined, "disclosure", 1]) {
      expect(ledgerDisclosureOf(stored)).toBeNull();
    }
    for (const kept of [
      undefined,
      "standard-contractual-clauses",
      { ...transfer, safeguard: "trust" },
      { ...transfer, article: 46 },
      { ...transfer, regime: null },
      { safeguard: "standard-contractual-clauses", article: "46(2)(c)", regime: "US" },
      { ...transfer, partialAdequacy: "dpf" },
      ...["scope", "decision", "celex", "covers", "condition"].map((field) => ({
        ...transfer,
        partialAdequacy: { ...PARTIAL_ADEQUACY.US, [field]: 1 },
      })),
    ]) {
      expect(ledgerDisclosureOf({ ...whole, transfer: kept })).toBeNull();
    }
    expect(ledgerDisclosureOf({ ...identity, safeguard: "trust", category: "c" })).toBeNull();
    expect(
      ledgerDisclosureOf({ ...identity, country: "us", safeguard: "adequacy", category: "c" }),
    ).toBeNull();
  });
});
