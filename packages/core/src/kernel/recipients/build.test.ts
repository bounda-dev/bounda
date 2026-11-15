import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { RecipientDeclaration } from "../../modules/recipient.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildPersonalCategories } from "../personal-data/categories.ts";
import { buildRecipients } from "./build.ts";

const categories = buildPersonalCategories({
  module: {
    categories: {
      contact: { basis: "consent", retention: "730d" },
      invoices: { basis: "legal-obligation", retention: "6y" },
    },
  },
  retention: null,
});

const handlers = {
  onPersonalDataForgotten: () => {},
  onProcessingRestricted: () => {},
  onProcessingRestrictionLiftAnnounced: () => {},
  onProcessingRestrictionLifted: () => {},
  onPersonalDataRedacted: () => {},
  onTenantForgotten: () => {},
};

const MAILCHIMP: RecipientDeclaration<string> = {
  name: " Mailchimp ",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  categories: ["contact"],
};

const registryWith = (recipients: Record<string, unknown>, ports?: object): Registry =>
  ({
    aggregates: {
      customer: {
        events: {},
        commands: {},
        policies: {},
        processes: {},
        ports: ports ?? { mailer: { memory: { default: {} } }, crm: { memory: { default: {} } } },
        recipients,
      },
    },
    readModels: {
      customers: {
        view: { fields: () => ({}) },
        projections: {},
        queries: {},
        ports: { audience: { memory: { default: {} } } },
        recipients: {
          audience: {
            ...handlers,
            recipient: {
              name: "Audience",
              kind: "processor",
              country: "DE",
              categories: ["contact"],
            },
          },
        },
      },
    },
  }) as unknown as Registry;

const built = (recipients: Record<string, unknown>, ports?: object) =>
  buildRecipients({
    registry: registryWith(recipients, ports),
    categories,
    ports: {
      byAggregate: { customer: { mailer: "mailer port", crm: "crm port" } },
      byReadModel: { customers: { audience: "audience port" } },
    },
  });

const refused = (recipients: Record<string, unknown>, message: string, ports?: object): void => {
  expect(() => built(recipients, ports)).toThrow(new ConfigurationError(message));
};

describe("buildRecipients", () => {
  it("holds each recipient by port, its name trimmed, by owner and by former key, with its implementation", () => {
    const recipients = built({
      mailer: { ...handlers, recipient: { ...MAILCHIMP, formerly: ["customer.newsletter"] } },
    });
    const mailer = recipients.byPort["customer.mailer"];
    expect(mailer).toMatchObject({
      port: "customer.mailer",
      owner: "customer",
      name: "mailer",
      recipient: "Mailchimp",
      kind: "processor",
      country: "US",
      safeguard: "standard-contractual-clauses",
      categories: ["contact"],
      formerly: ["customer.newsletter"],
    });
    expect(mailer?.implementation()).toBe("mailer port");
    expect(recipients.byPort["customers.audience"]).toMatchObject({
      safeguard: null,
      formerly: [],
    });
    expect(recipients.byPort["customers.audience"]?.implementation()).toBe("audience port");
    expect(recipients.byPort["customer.newsletter"]).toBe(mailer);
    expect(recipients.byOwner.customer?.mailer).toBe(mailer);
    expect(recipients.all.map(({ port }) => port)).toEqual([
      "customer.mailer",
      "customers.audience",
    ]);
    expect(Object.keys(mailer?.handlers ?? {})).toEqual(Object.keys(handlers));
  });

  it("refuses a declaration that is no object, or is an array or null", () => {
    for (const recipient of ["Mailchimp", null, [MAILCHIMP]]) {
      refused(
        { mailer: { ...handlers, recipient } },
        "Port customer.mailer: recipient must be an object: { name, kind, country, categories }",
      );
    }
  });

  it("refuses a name, a country or a category that is no string", () => {
    refused(
      { mailer: { ...handlers, recipient: { ...MAILCHIMP, name: 7 } } },
      "Port customer.mailer: recipient.name must name who receives the data",
    );
    refused(
      { mailer: { ...handlers, recipient: { ...MAILCHIMP, country: 840 } } },
      "Port customer.mailer: recipient.country 840 is not an ISO 3166-1 alpha-2 code",
    );
    refused(
      { mailer: { ...handlers, recipient: { ...MAILCHIMP, categories: [7] } } },
      "Port customer.mailer: recipient.categories names 7, which the app does not have",
    );
    refused(
      { mailer: { ...handlers, recipient: { ...MAILCHIMP, categories: "contact" } } },
      "Port customer.mailer: recipient.categories must list the categories of personal data the port sends it",
    );
  });

  it("refuses a former key that is no string, malformed, any of several, or not a list", () => {
    for (const formerly of [[7], ["customer.mailer", "Customer.Mail"], "customer.mail"]) {
      refused(
        { mailer: { ...handlers, recipient: { ...MAILCHIMP, formerly } } },
        'Port customer.mailer: recipient.formerly must list keys such as "customer.mailer", the port\'s before a rename',
      );
    }
  });

  it("refuses a former key that is a port of the app, declaring a recipient or not, or that two ports name", () => {
    refused(
      { mailer: { ...handlers, recipient: { ...MAILCHIMP, formerly: ["customer.crm"] } } },
      "Port customer.mailer: recipient.formerly names customer.crm, which is a port of the app",
    );
    refused(
      { mailer: { ...handlers, recipient: { ...MAILCHIMP, formerly: ["customers.audience"] } } },
      "Port customer.mailer: recipient.formerly names customers.audience, which is a port of the app",
    );
    refused(
      {
        mailer: { ...handlers, recipient: { ...MAILCHIMP, formerly: ["customer.old"] } },
        crm: { ...handlers, recipient: { ...MAILCHIMP, formerly: ["customer.old"] } },
      },
      "Port customer.crm: recipient.formerly names customer.old, which is formerly customer.mailer too",
    );
  });

  it("refuses a recipient of a port the owner does not have, with or without any port", () => {
    refused(
      { ghost: { ...handlers, recipient: MAILCHIMP } },
      "Port customer.ghost: it declares a recipient and has no implementation in infrastructure/ghost/",
    );
    expect(() =>
      buildRecipients({
        registry: {
          aggregates: {
            customer: {
              events: {},
              commands: {},
              policies: {},
              processes: {},
              recipients: { ghost: { ...handlers, recipient: MAILCHIMP } },
            },
          },
          readModels: {},
        } as unknown as Registry,
        categories,
        ports: { byAggregate: {}, byReadModel: {} },
      }),
    ).toThrow("Port customer.ghost: it declares a recipient and has no implementation");
  });
});
