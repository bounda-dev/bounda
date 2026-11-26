import { describe, expect, it } from "vitest";
import type { ForgottenRecipient } from "../../adapter/storage/recipient-store.ts";
import type { PersonRecipient } from "../../modules/recipient.ts";
import type { RecipientRuntime } from "../recipients/build.ts";
import { buildPersonalCategories } from "./categories.ts";
import { forgottenRecipients, tallyRecipients } from "./tenant-recipients.ts";

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
  transfer: {
    safeguard: "standard-contractual-clauses",
    article: "46(2)(c)",
    regime: "US",
    partialAdequacy: null,
  },
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
    const invoices = [{ name: "invoices", basis: "legal-obligation" }] as const;
    expect(
      tallied([
        [
          listed({ categories: invoices }),
          listed({ status: "presumed", firstDisclosedAt: null, lastDisclosedAt: null }),
        ],
        [listed()],
      ]),
    ).toEqual([
      {
        ...listed(),
        categories: [{ name: "default", basis: null }, ...invoices],
        persons: 2,
      },
      {
        ...listed({ status: "presumed", firstDisclosedAt: null, lastDisclosedAt: null }),
        persons: 1,
      },
    ]);
  });

  it("keeps the earliest and the latest disclosure of an identity", () => {
    const [recipient] = tallied([
      [listed({ firstDisclosedAt: "2026-01-03T00:00:00.000Z" })],
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
      persons: 3,
    });
  });

  it("orders by port, status, then identity: name, kind, country and safeguard", () => {
    const identities = tallied([
      [
        listed({ status: "declared", firstDisclosedAt: null, lastDisclosedAt: null }),
        listed({ transfer: null, country: "DE" }),
        listed({
          transfer: { safeguard: "adequacy", article: "45", regime: "CH", partialAdequacy: null },
          country: "CH",
        }),
        listed({ kind: "third-party" }),
        listed({ country: "CA" }),
        listed(),
        listed({ transfer: null }),
        listed({
          transfer: {
            safeguard: "binding-corporate-rules",
            article: "47",
            regime: "US",
            partialAdequacy: null,
          },
        }),
        listed({ name: "Brevo" }),
        listed({ name: "Postmark EU", country: "AU" }),
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
      "customer.mailer disclosed Postmark processor US -",
      "customer.mailer disclosed Postmark third-party US standard-contractual-clauses",
      "customer.mailer disclosed Postmark EU processor AU standard-contractual-clauses",
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
        ...listed({
          country: "CH",
          transfer: { safeguard: "adequacy", article: "45", regime: "CH", partialAdequacy: null },
        }),
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

const counted = (overrides: Partial<ForgottenRecipient> = {}): ForgottenRecipient => ({
  port: "customer.mailer",
  recipient: "Postmark",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  status: "disclosed",
  category: null,
  persons: 1,
  ...overrides,
});

const mailer = { port: "customer.mailer" } as RecipientRuntime;

const forgottenOf = (
  rows: readonly ForgottenRecipient[],
  byPort: Readonly<Record<string, RecipientRuntime>> = { "customer.mailer": mailer },
) => forgottenRecipients({ recipients: { byPort }, categories, counted: rows });

describe("forgottenRecipients", () => {
  const postmark = {
    port: "customer.mailer",
    name: "Postmark",
    kind: "processor",
    country: "US",
    transfer: {
      safeguard: "standard-contractual-clauses",
      article: "46(2)(c)",
      regime: "US",
      partialAdequacy: null,
    },
    status: "disclosed",
    declared: true,
  } as const;

  it("lists nothing when nobody was forgotten", () => {
    expect(forgottenOf([])).toEqual([]);
  });

  it("puts the counts of one identity and status together, each category with its basis", () => {
    expect(
      forgottenOf([
        counted({ category: "invoices", persons: 2 }),
        counted({ persons: 3 }),
        counted({ category: "default", persons: 4 }),
        counted({ category: "gone" }),
      ]),
    ).toEqual([
      {
        ...postmark,
        persons: 3,
        categories: [
          { name: "default", basis: null, persons: 4 },
          // A category the app no longer has keeps its count, with no basis to name.
          { name: "gone", basis: null, persons: 1 },
          { name: "invoices", basis: "legal-obligation", persons: 2 },
        ],
      },
    ]);
  });

  it("counts no person whole for a recipient only categories were forgotten of", () => {
    expect(forgottenOf([counted({ category: "invoices" })])).toEqual([
      {
        ...postmark,
        persons: 0,
        categories: [{ name: "invoices", basis: "legal-obligation", persons: 1 }],
      },
    ]);
  });

  it("sums under the port a former key names now, and tells one no longer declared", () => {
    expect(
      forgottenOf(
        [
          counted(),
          counted({ port: "customer.newsletter", persons: 2 }),
          counted({ port: "customer.gone" }),
        ],
        { "customer.mailer": mailer, "customer.newsletter": mailer },
      ),
    ).toEqual([
      { ...postmark, port: "customer.gone", declared: false, persons: 1, categories: [] },
      { ...postmark, persons: 3, categories: [] },
    ]);
  });

  it("orders them by port, status, name and identity, each identity apart", () => {
    const listed = forgottenOf([
      counted({ country: "FR", safeguard: null }),
      counted({ status: "presumed" }),
      counted({ safeguard: "binding-corporate-rules" }),
      counted({ recipient: "Brevo" }),
      counted({ port: "customer.crm" }),
      counted(),
      counted({ kind: "third-party" }),
    ]);
    expect(
      listed.map(({ port, name, kind, country, transfer, status }) => [
        port,
        status,
        name,
        kind,
        country,
        transfer?.safeguard ?? null,
      ]),
    ).toEqual([
      ["customer.crm", "disclosed", "Postmark", "processor", "US", "standard-contractual-clauses"],
      ["customer.mailer", "disclosed", "Brevo", "processor", "US", "standard-contractual-clauses"],
      ["customer.mailer", "disclosed", "Postmark", "processor", "FR", null],
      ["customer.mailer", "disclosed", "Postmark", "processor", "US", "binding-corporate-rules"],
      [
        "customer.mailer",
        "disclosed",
        "Postmark",
        "processor",
        "US",
        "standard-contractual-clauses",
      ],
      [
        "customer.mailer",
        "disclosed",
        "Postmark",
        "third-party",
        "US",
        "standard-contractual-clauses",
      ],
      [
        "customer.mailer",
        "presumed",
        "Postmark",
        "processor",
        "US",
        "standard-contractual-clauses",
      ],
    ]);
    expect(
      listed.find(({ transfer }) => transfer?.safeguard === "binding-corporate-rules"),
    ).toMatchObject({
      transfer: {
        safeguard: "binding-corporate-rules",
        article: "47",
        regime: "US",
        partialAdequacy: null,
      },
    });
  });
});
