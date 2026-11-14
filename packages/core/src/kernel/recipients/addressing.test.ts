import { beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { Disclosure } from "../../adapter/storage/recipient-store.ts";
import { testMetadata } from "../../adapter/testing/fixtures.ts";
import { memory } from "../../memory/index.ts";
import type {
  PersonalDataForgottenPayload,
  PersonalDataRedactedPayload,
} from "../../modules/bounda-events.ts";
import type { PersonalCategoryName } from "../../modules/personal-data.ts";
import { addressed, presumedOf } from "./addressing.ts";

const AT = "2026-03-01T00:00:00.000Z";

const disclosure = (port: string, category: string, person = "c-1"): Disclosure => ({
  person,
  port,
  recipient: "Mailchimp",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  category,
});

const forgotten = (
  overrides: Partial<PersonalDataForgottenPayload> = {},
): PersonalDataForgottenPayload => ({
  personId: "c-1",
  reason: "requested",
  whole: true,
  categories: ["contact", "profile"] as PersonalCategoryName[],
  retained: [],
  expired: [],
  cancelledCommands: [],
  removedDeadLetters: [],
  ...overrides,
});

const redacted = (categories: readonly string[]): PersonalDataRedactedPayload => ({
  personId: "c-1",
  events: [],
  categories: categories as PersonalCategoryName[],
  cancelledCommands: [],
  removedDeadLetters: [],
});

let storage: Storage;

// One event of the person on their own stream or the customer's, at the next position.
const append = async (
  aggregateType: string,
  type: string,
  payload: unknown = {},
  person = "c-1",
): Promise<number> =>
  storage.transact(async (transaction) => {
    const { version } = await transaction.eventStore.load({ aggregateType, aggregateId: person });
    const { events } = await transaction.eventStore.append({
      aggregateType,
      aggregateId: person,
      expectedVersion: version,
      events: [
        {
          id: `${type}-${person}-${version + 1}-${aggregateType}`,
          aggregateType,
          aggregateId: person,
          version: version + 1,
          type,
          payload,
          timestamp: AT,
          metadata: testMetadata,
          person,
        },
      ],
    });
    return events[0]?.position ?? 0;
  });

beforeEach(async () => {
  storage = await memory().createStorage();
});

describe("addressed", () => {
  it("leaves the payload as it is when no one is to be told", async () => {
    const payload = redacted(["contact"]);
    expect(
      await storage.transact((transaction) =>
        addressed(transaction, { type: "PersonalDataRedacted", payload }),
      ),
    ).toBe(payload);
  });

  it("tells each port of what it received that the event touches, sorted, and none of the rest", async () => {
    await storage.recipients.disclose(
      [
        disclosure("customer.mailer", "profile"),
        disclosure("customer.mailer", "contact"),
        disclosure("customer.crm", "invoices"),
        disclosure("customer.ads", "contact", "c-2"),
      ],
      AT,
    );
    const payload = await storage.transact((transaction) =>
      addressed(transaction, {
        type: "PersonalDataRedacted",
        payload: redacted(["profile", "contact"]),
      }),
    );
    expect(payload.recipients).toEqual([
      {
        port: "customer.mailer",
        categories: ["contact", "profile"],
        retained: [],
        presumed: false,
      },
    ]);
    const restricted = await storage.transact((transaction) =>
      addressed(transaction, {
        type: "ProcessingRestricted",
        payload: { personId: "c-1", ground: "legal-claims", categories: null, restrictions: [] },
      }),
    );
    expect((restricted as { recipients?: unknown }).recipients).toEqual([
      { port: "customer.crm", categories: ["invoices"], retained: [], presumed: false },
      {
        port: "customer.mailer",
        categories: ["contact", "profile"],
        retained: [],
        presumed: false,
      },
    ]);
    const lifted = await storage.transact((transaction) =>
      addressed(transaction, {
        type: "ProcessingRestrictionLifted",
        payload: {
          personId: "c-1",
          grounds: ["legal-claims"],
          categories: ["invoices"],
          restrictions: [],
        },
      }),
    );
    expect((lifted as { recipients?: unknown }).recipients).toEqual([
      { port: "customer.crm", categories: ["invoices"], retained: [], presumed: false },
    ]);
  });

  it("tells of a forgetting what it forgot or expired and what it kept, and removes what it forgot", async () => {
    await storage.recipients.disclose(
      [
        disclosure("customer.crm", "invoices"),
        disclosure("customer.crm", "contact"),
        disclosure("customer.old", "marketing"),
        disclosure("customer.mailer", "profile"),
      ],
      AT,
    );
    const payload = await storage.transact((transaction) =>
      addressed(transaction, {
        type: "PersonalDataForgotten",
        payload: forgotten({
          categories: ["contact"] as PersonalCategoryName[],
          retained: ["invoices"] as PersonalCategoryName[],
          expired: ["marketing"] as PersonalCategoryName[],
        }),
      }),
    );
    expect(payload.recipients).toEqual([
      { port: "customer.crm", categories: ["contact"], retained: ["invoices"], presumed: false },
      { port: "customer.old", categories: ["marketing"], retained: [], presumed: false },
    ]);
    expect(
      (await storage.recipients.disclosures("c-1")).map(({ port, category }) => [port, category]),
    ).toEqual([
      ["customer.crm", "invoices"],
      ["customer.mailer", "profile"],
    ]);
  });

  it("removes nothing for an event other than a forgetting", async () => {
    await storage.recipients.disclose([disclosure("customer.mailer", "contact")], AT);
    await storage.transact((transaction) =>
      addressed(transaction, { type: "PersonalDataRedacted", payload: redacted(["contact"]) }),
    );
    expect(await storage.recipients.disclosures("c-1")).toHaveLength(1);
  });

  it("is presumed only for the categories it holds no record of", async () => {
    await append("customer", "CustomerRegistered");
    await storage.recipients.declare(
      [{ port: "customer.mailer", categories: ["contact", "profile"] }],
      1,
      AT,
    );
    await storage.recipients.disclose([disclosure("customer.mailer", "contact")], AT);
    const one = await storage.transact((transaction) =>
      addressed(transaction, { type: "PersonalDataRedacted", payload: redacted(["contact"]) }),
    );
    expect(one.recipients).toEqual([
      { port: "customer.mailer", categories: ["contact"], retained: [], presumed: false },
    ]);
    const both = await storage.transact((transaction) =>
      addressed(transaction, {
        type: "PersonalDataRedacted",
        payload: redacted(["contact", "profile"]),
      }),
    );
    expect(both.recipients).toEqual([
      {
        port: "customer.mailer",
        categories: ["contact", "profile"],
        retained: [],
        presumed: false,
      },
    ]);
    const other = await storage.transact((transaction) =>
      addressed(transaction, { type: "PersonalDataRedacted", payload: redacted(["profile"]) }),
    );
    expect(other.recipients).toEqual([
      { port: "customer.mailer", categories: ["profile"], retained: [], presumed: true },
    ]);
  });
});

describe("addressed, presumed and recorded", () => {
  it("names the categories in order, those presumed and those recorded together", async () => {
    await append("customer", "CustomerRegistered");
    await storage.recipients.declare([{ port: "customer.mailer", categories: ["contact"] }], 1, AT);
    await storage.recipients.disclose([disclosure("customer.mailer", "profile")], AT);
    const payload = await storage.transact((transaction) =>
      addressed(transaction, {
        type: "PersonalDataRedacted",
        payload: redacted(["contact", "profile"]),
      }),
    );
    expect(payload.recipients).toEqual([
      {
        port: "customer.mailer",
        categories: ["contact", "profile"],
        retained: [],
        presumed: false,
      },
    ]);
  });
});

describe("presumedOf", () => {
  it("presumes a port declared after the person's first event, through its position, and none declared at 0", async () => {
    const first = await append("customer", "CustomerRegistered");
    await append("customer", "CustomerRegistered", {}, "c-2");
    await storage.recipients.declare([{ port: "customer.zero", categories: ["contact"] }], 0, AT);
    await storage.recipients.declare(
      [{ port: "customer.mailer", categories: ["contact", "profile"] }],
      first,
      AT,
    );
    const presumed = await storage.transact((transaction) => presumedOf(transaction, "c-1"));
    expect(presumed).toEqual(new Map([["customer.mailer", new Set(["contact", "profile"])]]));
    expect(await storage.transact((transaction) => presumedOf(transaction, "c-2"))).toEqual(
      new Map(),
    );
    expect(await storage.transact((transaction) => presumedOf(transaction, "c-9"))).toEqual(
      new Map(),
    );
  });

  it("drops what a forgetting told a port to erase, and nothing other events named", async () => {
    await append("customer", "CustomerRegistered");
    await storage.recipients.declare(
      [
        { port: "customer.mailer", categories: ["contact", "profile"] },
        { port: "customer.crm", categories: ["contact"] },
      ],
      1,
      AT,
    );
    await append("bounda", "ProcessingRestricted", {
      personId: "c-1",
      recipients: [
        { port: "customer.mailer", categories: ["profile"], retained: [], presumed: true },
      ],
    });
    await append("bounda", "PersonalDataForgotten", {
      ...forgotten(),
      recipients: [
        { port: "customer.mailer", categories: ["contact"], retained: [], presumed: true },
        { port: "customer.gone", categories: ["contact"], retained: [], presumed: false },
      ],
    });
    await append("bounda", "PersonalDataForgotten", forgotten());
    expect(await storage.transact((transaction) => presumedOf(transaction, "c-1"))).toEqual(
      new Map([
        ["customer.crm", new Set(["contact"])],
        ["customer.mailer", new Set(["profile"])],
      ]),
    );
  });
});
