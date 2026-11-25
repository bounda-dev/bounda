import { describe, expect, it } from "vitest";
import type { PersonRecipient } from "../../modules/recipient.ts";
import type { RecipientRuntime } from "../recipients/build.ts";
import { buildPersonalCategories } from "./categories.ts";
import { tallyRecipients } from "./tenant-recipients.ts";

const categories = buildPersonalCategories({
  module: {
    automatedDecisions: {},
    categories: {
      invoices: {
        basis: "legal-obligation",
        retention: "60d",
        purposes: ["Bill the customer"],
        sources: ["data-subject"],
      },
    },
  },
  retention: { months: 0, ms: 0 },
} as never);

const listed = (recipient: Partial<PersonRecipient> = {}): PersonRecipient => ({
  port: "customer.mailer",
  name: "Postmark",
  kind: "processor",
  country: "US",
  transfer: { safeguard: "standard-contractual-clauses", article: "46(2)(c)" },
  status: "disclosed",
  categories: [{ name: "default", basis: null }],
  firstDisclosedAt: "2026-01-02T00:00:00.000Z",
  lastDisclosedAt: "2026-01-02T00:00:00.000Z",
  declared: true,
  ...recipient,
});

const tallied = (
  persons: readonly (readonly PersonRecipient[])[],
  declared: readonly RecipientRuntime[] = [],
) => {
  const tally = tallyRecipients({ recipients: { all: declared }, categories });
  for (const recipients of persons) tally.add(recipients);
  return tally.recipients();
};

describe("tallyRecipients", () => {
  it("counts each person once per identity and status, with every category any of them lists", () => {
    expect(
      tallied([
        [listed(), listed({ status: "presumed", firstDisclosedAt: null, lastDisclosedAt: null })],
        [listed({ categories: [{ name: "invoices", basis: "legal-obligation" }] })],
      ]),
    ).toEqual([
      {
        ...listed(),
        categories: [
          { name: "default", basis: null },
          { name: "invoices", basis: "legal-obligation" },
        ],
        persons: 2,
      },
      {
        ...listed({ status: "presumed", firstDisclosedAt: null, lastDisclosedAt: null }),
        persons: 1,
      },
    ]);
  });

  it("keeps the earliest and the latest disclosure, a missing time never replacing a known one", () => {
    const [recipient] = tallied([
      [listed({ firstDisclosedAt: "2026-01-03T00:00:00.000Z" })],
      [listed({ firstDisclosedAt: null, lastDisclosedAt: null })],
      [
        listed({
          firstDisclosedAt: "2026-01-01T00:00:00.000Z",
          lastDisclosedAt: "2026-01-04T00:00:00.000Z",
        }),
      ],
      [listed({ firstDisclosedAt: "2026-01-02T00:00:00.000Z" })],
    ]);
    expect(recipient).toMatchObject({
      firstDisclosedAt: "2026-01-01T00:00:00.000Z",
      lastDisclosedAt: "2026-01-04T00:00:00.000Z",
      persons: 4,
    });
    const [late] = tallied([
      [listed({ firstDisclosedAt: null, lastDisclosedAt: null })],
      [listed()],
    ]);
    expect(late).toMatchObject({
      firstDisclosedAt: "2026-01-02T00:00:00.000Z",
      lastDisclosedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("orders by port, status, name, kind, country and safeguard, each identity apart", () => {
    const identities = tallied([
      [
        listed({ transfer: null, country: "DE" }),
        listed({ transfer: { safeguard: "adequacy", article: "45" }, country: "CH" }),
        listed({ kind: "third-party" }),
        listed({ country: "CA" }),
        listed({ transfer: { safeguard: "binding-corporate-rules", article: "47" } }),
        listed(),
        listed({ name: "Brevo" }),
        listed({ status: "declared", firstDisclosedAt: null, lastDisclosedAt: null }),
        listed({ port: "customer.crm" }),
      ],
    ]).map(({ port, status, name, kind, country, transfer }) =>
      [port, status, name, kind, country, transfer?.safeguard ?? "-"].join(" "),
    );
    expect(identities).toEqual([
      "customer.crm disclosed Postmark processor US standard-contractual-clauses",
      "customer.mailer disclosed Brevo processor US standard-contractual-clauses",
      "customer.mailer disclosed Postmark processor CA standard-contractual-clauses",
      "customer.mailer disclosed Postmark processor CH adequacy",
      "customer.mailer disclosed Postmark processor DE -",
      "customer.mailer disclosed Postmark processor US binding-corporate-rules",
      "customer.mailer disclosed Postmark processor US standard-contractual-clauses",
      "customer.mailer disclosed Postmark third-party US standard-contractual-clauses",
      "customer.mailer declared Postmark processor US standard-contractual-clauses",
    ]);
  });

  it("lists a recipient the app declares under an identity no person lists, for none", () => {
    const declared = (recipient: Partial<RecipientRuntime>): RecipientRuntime =>
      ({
        port: "customer.mailer",
        recipient: "Postmark",
        kind: "processor",
        country: "US",
        safeguard: "standard-contractual-clauses",
        categories: ["invoices", "default"],
        ...recipient,
      }) as RecipientRuntime;
    expect(
      tallied(
        [[listed()]],
        [
          declared({}),
          declared({ country: "CH", safeguard: "adequacy" }),
          declared({ port: "order.ledger", country: "DE", safeguard: null }),
        ],
      ),
    ).toEqual([
      { ...listed(), persons: 1 },
      {
        ...listed({ country: "CH", transfer: { safeguard: "adequacy", article: "45" } }),
        status: "declared",
        categories: [
          { name: "default", basis: null },
          { name: "invoices", basis: "legal-obligation" },
        ],
        firstDisclosedAt: null,
        lastDisclosedAt: null,
        persons: 0,
      },
      {
        ...listed({ port: "order.ledger", country: "DE", transfer: null }),
        status: "declared",
        categories: [
          { name: "default", basis: null },
          { name: "invoices", basis: "legal-obligation" },
        ],
        firstDisclosedAt: null,
        lastDisclosedAt: null,
        persons: 0,
      },
    ]);
  });
});
