import type { ForgetLedgerEntry } from "@bounda-dev/core/adapter";
import { describe, expect, it } from "vitest";
import { formatApplied, parseLedgerEntries } from "./ledger-entries.ts";

const AT = "2026-11-01T00:00:00.000Z";

const base: ForgetLedgerEntry = {
  personId: "c-1",
  categories: null,
  eventId: "e-1",
  forgottenAt: AT,
  reason: "requested",
};

const restricted = {
  type: "ProcessingRestricted",
  payload: {
    personId: "c-1",
    ground: "legal-claims",
    categories: ["contact"],
    restrictions: [{ ground: "legal-claims", categories: ["contact"], since: AT }],
  },
};

const announced = {
  type: "ProcessingRestrictionLiftAnnounced",
  payload: { personId: "c-1", grounds: ["legal-claims"], categories: null, liftsAt: AT },
};

const lifted = {
  type: "ProcessingRestrictionLifted",
  payload: { personId: "c-1", grounds: ["legal-claims"], categories: null, restrictions: [] },
};

const redaction = {
  events: [
    { id: "e-0", aggregateType: "customer", aggregateId: "c-1", type: "Registered", fields: ["a"] },
  ],
};

const disclosure = {
  port: "customer.mailer",
  recipient: "Acme Mail",
  kind: "processor",
  country: "DE",
  safeguard: null,
  category: "contact",
};

const lines = (...entries: readonly unknown[]): string =>
  entries.map((entry) => JSON.stringify(entry)).join("\n");

const NOT_AN_ENTRY =
  'line 2 is not a forget ledger\'s entry: it needs "personId", "eventId", "forgottenAt" as a time, "reason" and "categories", with "fingerprints" only as a list of strings, "committed" only as false and "reached" only as a position and a generation';

const NOT_ONE_KIND =
  'line 2 records at most one of a "restriction", a "redaction" and a "disclosure", each as a forget ledger keeps it';

describe("parseLedgerEntries", () => {
  it("reads every kind of entry as a forget ledger keeps it, skipping blank lines", () => {
    const entries = [
      { ...base, fingerprints: ["k-1"], categories: ["contact"], reason: "retention" },
      { ...base, eventId: "e-2", restriction: restricted, committed: false },
      { ...base, eventId: "e-3", restriction: announced, reached: { position: 4, generation: 1 } },
      { ...base, eventId: "e-4", restriction: lifted },
      { ...base, eventId: "e-5", redaction },
      { ...base, eventId: "e-6", disclosure, committed: false },
      { ...base, eventId: "e-7", disclosure: { ...disclosure, safeguard: "scc" } },
    ];
    expect(parseLedgerEntries(`\n${lines(...entries)}\n\n`)).toEqual(entries);
  });

  it("leaves out what is not an entry's", () => {
    expect(parseLedgerEntries(lines({ ...base, extra: "x" }))).toEqual([base]);
  });

  it("refuses a line that is not a forget ledger's entry, naming it and never what it holds", () => {
    for (const entry of [
      "a person",
      [],
      { ...base, personId: 3 },
      { ...base, personId: "" },
      { ...base, eventId: undefined },
      { ...base, eventId: "" },
      { ...base, forgottenAt: "yesterday" },
      { ...base, forgottenAt: 3 },
      { ...base, reason: "restored" },
      { ...base, categories: undefined },
      { ...base, categories: "contact" },
      { ...base, categories: [""] },
      { ...base, fingerprints: "k-1" },
      { ...base, fingerprints: [1] },
      { ...base, committed: true },
      { ...base, reached: { position: 1 } },
      { ...base, reached: { position: 1.5, generation: 0 } },
    ]) {
      expect(() => parseLedgerEntries(lines(base, entry))).toThrow(NOT_AN_ENTRY);
    }
    expect(() => parseLedgerEntries(`${lines(base)}\n{not json`)).toThrow("line 2 is not JSON");
  });

  it("refuses an entry of more than one kind, or one whose kind is not as a ledger keeps it", () => {
    const payload = restricted.payload;
    for (const entry of [
      { ...base, restriction: restricted, redaction },
      { ...base, disclosure, redaction },
      { ...base, restriction: { ...restricted, type: "PersonalDataForgotten" } },
      { ...base, restriction: { ...restricted, payload: { ...payload, personId: "c-2" } } },
      { ...base, restriction: { ...restricted, payload: "restricted" } },
      { ...base, restriction: { ...restricted, payload: { ...payload, ground: "none" } } },
      { ...base, restriction: { ...restricted, payload: { ...payload, categories: "a" } } },
      { ...base, restriction: { ...restricted, payload: { ...payload, restrictions: {} } } },
      {
        ...base,
        restriction: {
          ...restricted,
          payload: { ...payload, restrictions: [{ ground: "legal-claims", categories: null }] },
        },
      },
      {
        ...base,
        restriction: { ...announced, payload: { ...announced.payload, grounds: [] } },
      },
      {
        ...base,
        restriction: { ...announced, payload: { ...announced.payload, grounds: ["none"] } },
      },
      {
        ...base,
        restriction: { ...announced, payload: { ...announced.payload, liftsAt: "soon" } },
      },
      { ...base, restriction: { ...lifted, payload: { ...lifted.payload, grounds: "a" } } },
      { ...base, restriction: { ...lifted, payload: { ...lifted.payload, restrictions: null } } },
      { ...base, redaction: { events: [] } },
      { ...base, redaction: { events: [{ ...redaction.events[0], fields: "a" }] } },
      { ...base, redaction: { events: [{ ...redaction.events[0], id: "" }] } },
      { ...base, disclosure: { ...disclosure, port: "" } },
      { ...base, disclosure: { ...disclosure, safeguard: 1 } },
      { ...base, disclosure: { ...disclosure, safeguard: undefined } },
    ]) {
      expect(() => parseLedgerEntries(lines(base, entry))).toThrow(NOT_ONE_KIND);
    }
  });
});

describe("formatApplied", () => {
  it("says what applying each entry again did", () => {
    const of = { personId: "c-1", eventId: "e-1", kind: "restriction" } as const;
    expect(
      (["applied", "held", "reconciled", "inapplicable"] as const).map((outcome) =>
        formatApplied({ ...of, outcome }),
      ),
    ).toEqual([
      "applied again: the restriction e-1 of c-1",
      "held already: the restriction e-1 of c-1",
      "left to the reconciliation, which reads it in the ledger: the restriction e-1 of c-1",
      "refused, nothing of it applies to the database as it stands: the restriction e-1 of c-1",
    ]);
  });
});
