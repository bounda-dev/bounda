import { beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { Disclosure } from "../../adapter/storage/recipient-store.ts";
import { testMetadata } from "../../adapter/testing/fixtures.ts";
import { memory } from "../../memory/index.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../../modules/bounda-events.ts";
import { buildPersonalCategories } from "../personal-data/categories.ts";
import type { RecipientRuntime, RecipientsRuntime } from "./build.ts";
import { recipientStatuses, recipientsOf, recipientsOfPage } from "./listing.ts";

const categories = buildPersonalCategories({
  module: {
    automatedDecisions: {},
    categories: {
      contact: {
        basis: "consent",
        retention: "730d",
        purposes: ["Serve the person"],
        sources: ["data-subject"],
      },
      invoices: {
        basis: "legal-obligation",
        retention: "6y",
        purposes: ["Serve the person"],
        sources: ["data-subject"],
      },
    },
  },
  retention: null,
});

const recipient = (overrides: Partial<RecipientRuntime>): RecipientRuntime => ({
  port: "customer.mailer",
  owner: "customer",
  name: "mailer",
  recipient: "Mailchimp",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  categories: ["contact"],
  formerly: [],
  handlers: {} as RecipientRuntime["handlers"],
  implementation: () => undefined,
  ...overrides,
});

const MAILER = recipient({ formerly: ["customer.newsletter"] });
const CRM = recipient({
  port: "customer.crm",
  name: "crm",
  recipient: "Brevo",
  kind: "third-party",
  country: "FR",
  safeguard: null,
  categories: ["invoices", "contact"],
});
const ADS = recipient({
  port: "customer.ads",
  name: "ads",
  recipient: "Ads",
  categories: ["default"],
});

const runtime: RecipientsRuntime = {
  all: [MAILER, CRM, ADS],
  byPort: {
    "customer.mailer": MAILER,
    "customer.newsletter": MAILER,
    "customer.crm": CRM,
    "customer.ads": ADS,
  },
  byOwner: { customer: { mailer: MAILER, crm: CRM, ads: ADS } },
};

const disclosure = (overrides: Partial<Disclosure>): Disclosure => ({
  person: "c-1",
  port: "customer.mailer",
  recipient: "Mailchimp",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  category: "contact",
  ...overrides,
});

let storage: Storage;

const key = (person: string, category: string): Promise<unknown> =>
  storage.personalKeys.add(person, category, {
    key: "k",
    fingerprint: `${person}-${category}`,
    kid: null,
  });

beforeEach(async () => {
  storage = await memory().createStorage();
});

describe("recipientsOf", () => {
  it("lists nothing for a person no recipient may hold anything of", async () => {
    expect(
      await recipientsOf({ storage, recipients: runtime, categories, personId: "c-1" }),
    ).toEqual([]);
  });

  it("lists what was disclosed, by recipient as it was then, from its first time to its last, and what may still go", async () => {
    await key("c-1", "contact");
    await key("c-1", "invoices");
    await storage.recipients.disclose(
      [disclosure({ port: "customer.newsletter" }), disclosure({ recipient: "Mandrill" })],
      "2026-02-03T00:00:00.000Z",
    );
    await storage.recipients.disclose([disclosure({})], "2026-02-01T00:00:00.000Z");
    await storage.recipients.disclose(
      [disclosure({ category: "invoices", port: "customer.mailer" })],
      "2026-02-02T00:00:00.000Z",
    );
    await storage.recipients.disclose(
      [disclosure({ port: "order.sms", recipient: "Twilio", category: "contact" })],
      "2026-02-04T00:00:00.000Z",
    );
    expect(
      await recipientsOf({ storage, recipients: runtime, categories, personId: "c-1" }),
    ).toEqual([
      {
        port: "customer.crm",
        name: "Brevo",
        kind: "third-party",
        country: "FR",
        transfer: null,
        status: "declared",
        categories: [
          { name: "contact", basis: "consent" },
          { name: "invoices", basis: "legal-obligation" },
        ],
        firstDisclosedAt: null,
        lastDisclosedAt: null,
        declared: true,
      },
      {
        port: "customer.mailer",
        name: "Mailchimp",
        kind: "processor",
        country: "US",
        transfer: { safeguard: "standard-contractual-clauses", article: "46(2)(c)", regime: "US" },
        status: "disclosed",
        categories: [
          { name: "contact", basis: "consent" },
          { name: "invoices", basis: "legal-obligation" },
        ],
        firstDisclosedAt: "2026-02-01T00:00:00.000Z",
        lastDisclosedAt: "2026-02-03T00:00:00.000Z",
        declared: true,
      },
      {
        port: "customer.mailer",
        name: "Mandrill",
        kind: "processor",
        country: "US",
        transfer: { safeguard: "standard-contractual-clauses", article: "46(2)(c)", regime: "US" },
        status: "disclosed",
        categories: [{ name: "contact", basis: "consent" }],
        firstDisclosedAt: "2026-02-03T00:00:00.000Z",
        lastDisclosedAt: "2026-02-03T00:00:00.000Z",
        declared: true,
      },
      {
        port: "order.sms",
        name: "Twilio",
        kind: "processor",
        country: "US",
        transfer: { safeguard: "standard-contractual-clauses", article: "46(2)(c)", regime: "US" },
        status: "disclosed",
        categories: [{ name: "contact", basis: "consent" }],
        firstDisclosedAt: "2026-02-04T00:00:00.000Z",
        lastDisclosedAt: "2026-02-04T00:00:00.000Z",
        declared: false,
      },
    ]);
  });

  it("lists a presumed recipient for the categories the person holds, not recorded, and none the app no longer declares", async () => {
    await key("c-1", "contact");
    await key("c-1", "invoices");
    await storage.transact(async (transaction) => {
      await transaction.eventStore.append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: 0,
        events: [
          {
            id: "e-1",
            aggregateType: "customer",
            aggregateId: "c-1",
            version: 1,
            type: "CustomerRegistered",
            payload: {},
            timestamp: "2026-01-01T00:00:00.000Z",
            metadata: testMetadata,
            person: "c-1",
          },
        ],
      });
    });
    await storage.recipients.declare(
      [
        { port: "customer.crm", categories: ["invoices", "contact", "marketing"] },
        { port: "order.gone", categories: ["contact"] },
      ],
      1,
      "2026-01-02T00:00:00.000Z",
    );
    await storage.recipients.disclose(
      [disclosure({ port: "customer.crm", recipient: "Brevo", category: "invoices" })],
      "2026-02-01T00:00:00.000Z",
    );
    const listed = await recipientsOf({
      storage,
      recipients: runtime,
      categories,
      personId: "c-1",
    });
    expect(
      listed.map(({ port, status, categories: names }) => [
        port,
        status,
        names.map(({ name }) => name),
      ]),
    ).toEqual([
      ["customer.crm", "disclosed", ["invoices"]],
      ["customer.crm", "presumed", ["contact"]],
      ["customer.mailer", "declared", ["contact"]],
    ]);
    expect(listed[1]).toMatchObject({
      name: "Brevo",
      kind: "third-party",
      country: "FR",
      transfer: null,
      firstDisclosedAt: null,
      lastDisclosedAt: null,
      declared: true,
    });
  });
});

describe("recipientsOfPage", () => {
  const append = async (
    aggregateType: string,
    aggregateId: string,
    type: string,
    payload: unknown,
    person: string | null,
  ) => {
    const { version } = await storage.eventStore.load({ aggregateType, aggregateId });
    await storage.eventStore.append({
      aggregateType,
      aggregateId,
      expectedVersion: version,
      events: [
        {
          id: `${aggregateId}-${type}-${version + 1}`,
          aggregateType,
          aggregateId,
          version: version + 1,
          type,
          payload,
          timestamp: "2026-01-01T00:00:00.000Z",
          metadata: testMetadata,
          person,
        },
      ],
    });
  };

  // Counts each read of the event store the page makes.
  const counting = (eventStore: EventStore) => {
    const reads = new Map<string, number>();
    const counted = new Proxy(eventStore, {
      get: (target, name, receiver) => {
        const value = Reflect.get(target, name, receiver) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          reads.set(String(name), (reads.get(String(name)) ?? 0) + 1);
          return (value as (...given: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return { counted, reads };
  };

  it("lists each person as recipientsOf does, in two reads of the event store however many persons the page holds", async () => {
    const persons = Array.from(
      { length: 120 },
      (_, index) => `c-${String(index).padStart(3, "0")}`,
    );
    for (const person of persons) {
      await key(person, "contact");
      await key(person, "invoices");
      await append("customer", person, "CustomerRegistered", {}, person);
    }
    await storage.recipients.declare(
      [{ port: "customer.crm", categories: ["invoices", "contact"] }],
      100,
      "2026-01-02T00:00:00.000Z",
    );
    // A person whose data came after the declaration, and one a forgetting told to forget a part.
    await append("customer", "c-late", "CustomerRegistered", {}, "c-late");
    await key("c-late", "contact");
    await append(
      BOUNDA_AGGREGATE,
      "c-001",
      PERSONAL_DATA_FORGOTTEN_EVENT,
      {
        personId: "c-001",
        categories: ["invoices"],
        expired: [],
        retained: [],
        recipients: [
          { port: "customer.crm", categories: ["invoices"], retained: [], presumed: true },
        ],
      },
      "c-001",
    );
    const page = [...persons, "c-late", "c-none"];
    const { counted, reads } = counting(storage.eventStore);
    const listed = await recipientsOfPage({
      storage: { ...storage, eventStore: counted },
      recipients: runtime,
      categories,
      persons: page,
      keys: await storage.personalKeys.listMany(page),
    });
    expect(Object.fromEntries(reads)).toEqual({ firstPositions: 1, loadMany: 1 });
    for (const person of page) {
      expect(listed.get(person)).toEqual(
        await recipientsOf({ storage, recipients: runtime, categories, personId: person }),
      );
    }
    const statuses = (person: string) =>
      listed
        .get(person)
        ?.map(({ port, status, categories: names }) => [
          port,
          status,
          names.map(({ name }) => name),
        ]);
    expect(statuses("c-000")).toEqual([
      ["customer.crm", "presumed", ["contact", "invoices"]],
      ["customer.mailer", "declared", ["contact"]],
    ]);
    expect(statuses("c-001")).toEqual([
      ["customer.crm", "presumed", ["contact"]],
      ["customer.crm", "declared", ["invoices"]],
      ["customer.mailer", "declared", ["contact"]],
    ]);
    expect(statuses("c-late")).toEqual([
      ["customer.crm", "declared", ["contact"]],
      ["customer.mailer", "declared", ["contact"]],
    ]);
    expect(listed.get("c-none")).toEqual([]);
  });

  it("reads no event for a page when no recipient was declared late", async () => {
    await storage.recipients.declare(
      [{ port: "customer.crm", categories: ["contact"] }],
      0,
      "2026-01-02T00:00:00.000Z",
    );
    await key("c-1", "contact");
    await append("customer", "c-1", "CustomerRegistered", {}, "c-1");
    const { counted, reads } = counting(storage.eventStore);
    await recipientsOfPage({
      storage: { ...storage, eventStore: counted },
      recipients: runtime,
      categories,
      persons: ["c-1"],
      keys: await storage.personalKeys.listMany(["c-1"]),
    });
    expect(reads.size).toBe(0);
  });

  it("loads no stream when no person of the page came before a recipient declared late", async () => {
    await storage.recipients.declare(
      [{ port: "customer.crm", categories: ["contact"] }],
      1,
      "2026-01-02T00:00:00.000Z",
    );
    await append("customer", "c-0", "CustomerRegistered", {}, null);
    await append("customer", "c-1", "CustomerRegistered", {}, "c-1");
    await key("c-1", "contact");
    const { counted, reads } = counting(storage.eventStore);
    await recipientsOfPage({
      storage: { ...storage, eventStore: counted },
      recipients: runtime,
      categories,
      persons: ["c-1", "c-2"],
      keys: await storage.personalKeys.listMany(["c-1", "c-2"]),
    });
    expect(Object.fromEntries(reads)).toEqual({ firstPositions: 1 });
  });
});

describe("recipientsOf, merged and ordered", () => {
  it("merges a recipient's rows from the first time to the last, names a category gone without a basis, and orders by port, status and name", async () => {
    await key("c-1", "contact");
    await key("c-1", "invoices");
    await storage.recipients.disclose(
      [disclosure({ port: "customer.newsletter", recipient: "Alpha", category: "marketing" })],
      "2026-02-07T00:00:00.000Z",
    );
    await storage.recipients.disclose(
      [disclosure({ port: "customer.crm", recipient: "Brevo", category: "contact" })],
      "2026-02-05T00:00:00.000Z",
    );
    await storage.recipients.disclose(
      [disclosure({ port: "customer.crm", recipient: "Brevo", category: "contact" })],
      "2026-02-06T00:00:00.000Z",
    );
    await storage.recipients.disclose(
      [disclosure({ port: "customer.crm", recipient: "Brevo", category: "invoices" })],
      "2026-02-01T00:00:00.000Z",
    );
    await storage.recipients.disclose(
      [disclosure({ port: "customer.crm", recipient: "Brevo", category: "invoices" })],
      "2026-02-03T00:00:00.000Z",
    );
    await storage.recipients.disclose(
      [disclosure({ port: "customer.mailer", recipient: "Mandrill", category: "contact" })],
      "2026-02-02T00:00:00.000Z",
    );
    const listed = await recipientsOf({
      storage,
      recipients: runtime,
      categories,
      personId: "c-1",
    });
    expect(
      listed.map(({ port, name, status, firstDisclosedAt, lastDisclosedAt, categories: names }) => [
        port,
        name,
        status,
        firstDisclosedAt,
        lastDisclosedAt,
        names,
      ]),
    ).toEqual([
      [
        "customer.crm",
        "Brevo",
        "disclosed",
        "2026-02-01T00:00:00.000Z",
        "2026-02-06T00:00:00.000Z",
        [
          { name: "contact", basis: "consent" },
          { name: "invoices", basis: "legal-obligation" },
        ],
      ],
      [
        "customer.mailer",
        "Alpha",
        "disclosed",
        "2026-02-07T00:00:00.000Z",
        "2026-02-07T00:00:00.000Z",
        [{ name: "marketing", basis: null }],
      ],
      [
        "customer.mailer",
        "Mandrill",
        "disclosed",
        "2026-02-02T00:00:00.000Z",
        "2026-02-02T00:00:00.000Z",
        [{ name: "contact", basis: "consent" }],
      ],
    ]);
  });

  it("orders a port's statuses disclosed, presumed, declared", async () => {
    await key("c-1", "contact");
    await key("c-1", "invoices");
    await storage.transact(async (transaction) => {
      await transaction.eventStore.append({
        aggregateType: "customer",
        aggregateId: "c-1",
        expectedVersion: 0,
        events: [
          {
            id: "e-1",
            aggregateType: "customer",
            aggregateId: "c-1",
            version: 1,
            type: "CustomerRegistered",
            payload: {},
            timestamp: "2026-01-01T00:00:00.000Z",
            metadata: testMetadata,
            person: "c-1",
          },
        ],
      });
    });
    await storage.recipients.declare([{ port: "customer.crm", categories: ["contact"] }], 1, "t");
    await storage.recipients.disclose(
      [disclosure({ port: "customer.crm", recipient: "Brevo", category: "marketing" })],
      "2026-02-01T00:00:00.000Z",
    );
    expect(
      (await recipientsOf({ storage, recipients: runtime, categories, personId: "c-1" }))
        .filter(({ port }) => port === "customer.crm")
        .map(({ status }) => status),
    ).toEqual(["disclosed", "presumed", "declared"]);
  });
});

describe("recipientStatuses", () => {
  it("lists every recipient declared or remembered, with its persons, whether it catches up, and its failed notices under any key", async () => {
    await storage.recipients.disclose(
      [
        disclosure({}),
        disclosure({ person: "c-2" }),
        disclosure({ port: "order.sms", recipient: "Twilio" }),
        disclosure({ port: "customer.newsletter", person: "c-3" }),
      ],
      "2026-02-01T00:00:00.000Z",
    );
    await storage.recipients.declare(
      [
        { port: "customer.crm", categories: ["contact"] },
        { port: "customer.ads", categories: ["default"] },
      ],
      4,
      "2026-02-01T00:00:00.000Z",
    );
    await storage.recipients.caughtUp("customer.ads", 4);
    await storage.recipients.declare(
      [{ port: "order.gone", categories: ["contact"] }],
      0,
      "2026-02-01T00:00:00.000Z",
    );
    const letter = (id: string, handler: string, status?: "discarded") =>
      storage.transact(async (transaction) => {
        await transaction.deadLetterStore.add({
          id,
          kind: "recipient",
          handler,
          eventId: id,
          eventType: "PersonalDataForgotten",
          aggregateType: "bounda",
          aggregateId: "c-1",
          person: "c-1",
          errorType: "terminal",
          errorName: "Error",
          errorMessage: "down",
          attempts: 1,
          firstFailedAt: "2026-02-01T00:00:00.000Z",
          lastFailedAt: "2026-02-01T00:00:00.000Z",
        });
        if (status !== undefined) {
          await transaction.deadLetterStore.updateStatus(
            id,
            status,
            new Date("2026-02-02T00:00:00.000Z"),
          );
        }
      });
    await letter("l-1", "customer.mailer");
    await letter("l-2", "customer.newsletter");
    await letter("l-3", "customer.mailer", "discarded");
    await letter("l-4", "order.sms");
    expect(await recipientStatuses({ storage, recipients: runtime })).toEqual([
      {
        port: "customer.ads",
        declared: {
          name: "Ads",
          kind: "processor",
          country: "US",
          transfer: {
            safeguard: "standard-contractual-clauses",
            article: "46(2)(c)",
            regime: "US",
          },
          categories: ["default"],
        },
        persons: 0,
        catchingUp: false,
        failedNotices: 0,
      },
      {
        port: "customer.crm",
        declared: {
          name: "Brevo",
          kind: "third-party",
          country: "FR",
          transfer: null,
          categories: ["invoices", "contact"],
        },
        persons: 0,
        catchingUp: true,
        failedNotices: 0,
      },
      {
        port: "customer.mailer",
        declared: {
          name: "Mailchimp",
          kind: "processor",
          country: "US",
          transfer: {
            safeguard: "standard-contractual-clauses",
            article: "46(2)(c)",
            regime: "US",
          },
          categories: ["contact"],
        },
        persons: 2,
        catchingUp: false,
        failedNotices: 2,
      },
      {
        port: "customer.newsletter",
        declared: null,
        persons: 1,
        catchingUp: false,
        failedNotices: 1,
      },
      { port: "order.gone", declared: null, persons: 0, catchingUp: false, failedNotices: 0 },
      { port: "order.sms", declared: null, persons: 1, catchingUp: false, failedNotices: 1 },
    ]);
  });
});
