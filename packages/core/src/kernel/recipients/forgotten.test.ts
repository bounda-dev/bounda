import { describe, expect, it } from "vitest";
import type { ForgottenRecipient } from "../../adapter/storage/recipient-store.ts";
import type { PersonRecipient } from "../../modules/recipient.ts";
import { forgottenFrom } from "./forgotten.ts";

const listed = (recipient: Partial<PersonRecipient> = {}): PersonRecipient => ({
  port: "customer.mailer",
  name: "Mailchimp",
  kind: "processor",
  country: "US",
  transfer: {
    safeguard: "standard-contractual-clauses",
    article: "46(2)(c)",
    regime: "US",
    partialAdequacy: null,
  },
  status: "disclosed",
  categories: [
    { name: "contact", basis: "consent" },
    { name: "invoices", basis: "legal-obligation" },
  ],
  firstDisclosedAt: "2026-01-02T00:00:00.000Z",
  lastDisclosedAt: "2026-01-05T00:00:00.000Z",
  declared: true,
  ...recipient,
});

const counted = (overrides: Partial<ForgottenRecipient> = {}): ForgottenRecipient => ({
  port: "customer.mailer",
  recipient: "Mailchimp",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  status: "disclosed",
  category: null,
  persons: 1,
  ...overrides,
});

describe("forgottenFrom", () => {
  it("counts nothing when the forgetting took nothing off the list", () => {
    expect(forgottenFrom({ before: [listed()], after: [listed()] })).toEqual([]);
    expect(forgottenFrom({ before: [], after: [] })).toEqual([]);
  });

  it("counts each category taken off a recipient still listed, and not the person", () => {
    expect(
      forgottenFrom({
        before: [listed()],
        // Its times are the person's: what is left of them tells nothing here.
        after: [
          listed({
            categories: [{ name: "contact", basis: "consent" }],
            firstDisclosedAt: "2026-01-03T00:00:00.000Z",
          }),
        ],
      }),
    ).toEqual([counted({ category: "invoices" })]);
  });

  it("counts every category of a recipient no longer listed, and the person once", () => {
    expect(forgottenFrom({ before: [listed()], after: [] })).toEqual([
      counted({ category: "contact" }),
      counted({ category: "invoices" }),
      counted(),
    ]);
  });

  it("counts a presumed recipient as presumed, and a declared one not at all", () => {
    expect(
      forgottenFrom({
        before: [
          listed({
            status: "presumed",
            categories: [{ name: "contact", basis: "consent" }],
            firstDisclosedAt: null,
            lastDisclosedAt: null,
          }),
          listed({ port: "customer.crm", status: "declared", firstDisclosedAt: null }),
        ],
        after: [],
      }),
    ).toEqual([
      counted({ status: "presumed", category: "contact" }),
      counted({ status: "presumed" }),
    ]);
  });

  it("tells a recipient's identities and statuses apart, so one left listed keeps another counted", () => {
    const inEurope = listed({ name: "Brevo", country: "FR", transfer: null });
    const presumed = listed({ status: "presumed", firstDisclosedAt: null, lastDisclosedAt: null });
    const elsewhere = listed({
      transfer: {
        safeguard: "binding-corporate-rules",
        article: "47",
        regime: "US",
        partialAdequacy: null,
      },
    });
    expect(
      forgottenFrom({
        before: [listed(), inEurope, presumed, elsewhere],
        after: [inEurope, listed({ kind: "joint-controller" }), listed({ port: "customer.crm" })],
      }),
    ).toEqual([
      counted({ category: "contact" }),
      counted({ category: "invoices" }),
      counted(),
      counted({ status: "presumed", category: "contact" }),
      counted({ status: "presumed", category: "invoices" }),
      counted({ status: "presumed" }),
      counted({ safeguard: "binding-corporate-rules", category: "contact" }),
      counted({ safeguard: "binding-corporate-rules", category: "invoices" }),
      counted({ safeguard: "binding-corporate-rules" }),
    ]);
  });

  it("counts a recipient whose transfer rested on another safeguard, though one on the first is left", () => {
    const elsewhere = listed({
      transfer: {
        safeguard: "binding-corporate-rules",
        article: "47",
        regime: "US",
        partialAdequacy: null,
      },
    });
    const inEurope = listed({ country: "FR", transfer: null });
    expect(forgottenFrom({ before: [listed(), elsewhere, inEurope], after: [listed()] })).toEqual([
      counted({ safeguard: "binding-corporate-rules", category: "contact" }),
      counted({ safeguard: "binding-corporate-rules", category: "invoices" }),
      counted({ safeguard: "binding-corporate-rules" }),
      counted({ country: "FR", safeguard: null, category: "contact" }),
      counted({ country: "FR", safeguard: null, category: "invoices" }),
      counted({ country: "FR", safeguard: null }),
    ]);
  });

  it("names a recipient in the European Economic Area with no safeguard", () => {
    expect(
      forgottenFrom({
        before: [
          listed({
            country: "FR",
            transfer: null,
            categories: [{ name: "contact", basis: "consent" }],
          }),
        ],
        after: [],
      }),
    ).toEqual([
      counted({ country: "FR", safeguard: null, category: "contact" }),
      counted({ country: "FR", safeguard: null }),
    ]);
  });
});
