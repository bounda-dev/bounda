import { beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { ForgetLedgerEntry, LedgerDisclosure } from "../../adapter/storage/forget-ledger.ts";
import { testMetadata } from "../../adapter/testing/fixtures.ts";
import { memory } from "../../memory/index.ts";
import { discloseAgain } from "./again.ts";

const disclosure: LedgerDisclosure = {
  port: "customer.mailer",
  recipient: "Mailchimp",
  kind: "processor",
  country: "US",
  transfer: { safeguard: "standard-contractual-clauses", article: "46(2)(c)", regime: "US" },
  category: "contact",
};

const entry = (
  personId: string,
  forgottenAt: string,
): ForgetLedgerEntry & { readonly disclosure: LedgerDisclosure } => ({
  personId,
  categories: null,
  eventId: `disclosed-${personId}`,
  forgottenAt,
  reason: "requested",
  disclosure,
});

let storage: Storage;

const forget = async (
  person: string,
  timestamp: string,
  categories: readonly string[],
  expired: readonly string[] = [],
  type = "PersonalDataForgotten",
): Promise<void> => {
  await storage.transact(async (transaction) => {
    const { version } = await transaction.eventStore.load({
      aggregateType: "bounda",
      aggregateId: person,
    });
    await transaction.eventStore.append({
      aggregateType: "bounda",
      aggregateId: person,
      expectedVersion: version,
      events: [
        {
          id: `${type}-${person}-${version + 1}`,
          aggregateType: "bounda",
          aggregateId: person,
          version: version + 1,
          type,
          payload: { personId: person, categories, expired, retained: [] },
          timestamp,
          metadata: testMetadata,
          person,
        },
      ],
    });
  });
};

beforeEach(async () => {
  storage = await memory().createStorage();
});

describe("discloseAgain", () => {
  it("records a disclosure the store lost, at its first time, and resolves whether it did", async () => {
    const at = "2026-02-01T00:00:00.000Z";
    expect(await discloseAgain({ storage, concurrencyRetries: 0, entry: entry("c-1", at) })).toBe(
      true,
    );
    expect(await storage.recipients.disclosures("c-1")).toEqual([
      {
        person: "c-1",
        port: "customer.mailer",
        recipient: "Mailchimp",
        kind: "processor",
        country: "US",
        safeguard: "standard-contractual-clauses",
        category: "contact",
        firstAt: at,
        lastAt: at,
      },
    ]);
    expect(await discloseAgain({ storage, concurrencyRetries: 0, entry: entry("c-1", at) })).toBe(
      false,
    );
  });

  it("records a recipient in the European Economic Area with no safeguard", async () => {
    const at = "2026-02-01T00:00:00.000Z";
    const inEea = {
      ...entry("c-1", at),
      disclosure: { ...disclosure, country: "FR", transfer: null },
    };
    expect(await discloseAgain({ storage, concurrencyRetries: 0, entry: inEea })).toBe(true);
    expect(await storage.recipients.disclosures("c-1")).toEqual([
      expect.objectContaining({ country: "FR", safeguard: null }),
    ]);
  });

  it("leaves one a later forgetting of its category told and removed, and no other's", async () => {
    const at = "2026-02-01T00:00:00.000Z";
    await forget("c-1", "2026-02-02T00:00:00.000Z", ["contact"]);
    await forget("c-2", "2026-02-02T00:00:00.000Z", [], ["contact"]);
    await forget("c-3", "2026-01-01T00:00:00.000Z", ["contact"]);
    await forget("c-4", "2026-02-02T00:00:00.000Z", ["invoices"]);
    await forget("c-5", "2026-02-02T00:00:00.000Z", ["contact"], [], "ProcessingRestricted");
    await forget("c-6", at, ["contact"]);
    const again = async (person: string) =>
      discloseAgain({ storage, concurrencyRetries: 0, entry: entry(person, at) });
    expect(await again("c-1")).toBe(false);
    expect(await again("c-2")).toBe(false);
    expect(await again("c-6")).toBe(false);
    expect(await again("c-3")).toBe(true);
    expect(await again("c-4")).toBe(true);
    expect(await again("c-5")).toBe(true);
    expect(await storage.recipients.disclosures("c-1")).toEqual([]);
    expect(await storage.recipients.disclosures("c-3")).toHaveLength(1);
  });
});
