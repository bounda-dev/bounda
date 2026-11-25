import type { AppStatus, SubscriberFailure } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { formatRestored, formatSchema, formatStatus } from "./status-output.ts";

const failure = {
  subscriber: "projection:orders",
  position: 7,
  eventId: "e-7",
  eventType: "OrderPlaced",
  person: "c-1",
  errorName: "ValidationError",
  errorCode: "VALIDATION_FAILED",
  attempts: 3,
  firstFailedAt: "2026-05-01T00:00:00.000Z",
  lastFailedAt: "2026-05-01T00:01:00.000Z",
  resolvedAt: null,
};

const { errorCode: _code, ...withoutCode } = failure;

const status: AppStatus = {
  schema: [
    { database: "storage", scope: "storage", version: 1, latest: 2 },
    { database: "storage", scope: "checkpoints", version: 1, latest: 1 },
  ],
  restoresFound: 2,
  lag: {
    lastPosition: 9,
    maxLag: 3,
    subscribers: [
      { subscriber: "projection:orders", position: 6, lag: 3 },
      { subscriber: "policies", position: 9, lag: 0 },
      { subscriber: "processes", position: 9, lag: 0 },
    ],
    waitingDeadlines: 0,
    forgetLedger: { reconciled: true },
  },
  subscriberFailures: [
    { ...failure, current: true },
    {
      ...withoutCode,
      subscriber: "policies",
      errorName: "Error",
      attempts: 1,
      resolvedAt: "2026-05-02T00:00:00.000Z",
      current: false,
    },
  ],
  personalDataBackfill: { position: 9, caughtUp: false },
  forgetLedger: {
    reconciled: false,
    appliedThrough: "2026-04-30T00:00:00.000Z",
    lastRunAt: null,
    held: { until: "2026-05-01T00:05:00.000Z", attempts: 2 },
  },
  tenant: {
    tenant: "acme",
    forgottenAt: null,
    kid: "t-2",
    previous: ["t-1"],
    master: { kid: "m-2", previous: ["m-1"], pending: 1 },
  },
  forgottenTenant: null,
  frozenTenant: null,
  keyRotation: { kid: "k-2", previous: ["k-1"], pending: 1, completeAt: null, reseal: null },
  retention: {
    categories: [
      { category: "default", retention: "30d", due: 1, nextDueAt: "2026-05-03T00:00:00.000Z" },
      { category: "invoices", retention: "6y", due: 2, nextDueAt: null },
    ],
    keptBeyond: 1,
  },
  deadLetterRetention: { retentionMs: 90_000, nextDueAt: null, held: 0, withoutHandler: 0 },
  subscriberFailureRetention: {
    retentionMs: 2_592_000_000,
    nextDueAt: "2026-05-04T00:00:00.000Z",
    held: 2,
  },
  recipients: [
    {
      port: "customer.crm",
      declared: {
        name: "Brevo",
        kind: "third-party",
        country: "FR",
        safeguard: null,
        categories: ["contact", "invoices"],
      },
      persons: 1,
      catchingUp: true,
      failedNotices: 0,
    },
    {
      port: "customer.mailer",
      declared: {
        name: "Mailchimp",
        kind: "processor",
        country: "US",
        safeguard: "standard-contractual-clauses",
        categories: ["contact"],
      },
      persons: 3,
      catchingUp: false,
      failedNotices: 2,
    },
    {
      port: "order.sms",
      declared: null,
      persons: 4,
      catchingUp: false,
      failedNotices: 1,
    },
  ],
  files: [
    { database: "storage", file: "data/acme.db", state: "current" },
    { database: "readModels.reports", file: "data/reports.db", state: "earlier" },
    { database: "readModels.audit", file: "data/audit.db", state: "clear" },
  ],
};

describe("formatStatus", () => {
  it("prints every section, the failures without their text, and what is pending", () => {
    expect(formatStatus({ status }).split("\n")).toEqual([
      "tables",
      "  storage  storage  1 of 2  (migrations pending: bounda migrate)",
      "  storage  checkpoints  1 of 1",
      "restores found while running: 2",
      "subscribers (head at 9)",
      "  projection:orders  at 6, 3 behind",
      "    failing: ValidationError (VALIDATION_FAILED) on OrderPlaced at 7, 3 attempts since 2026-05-01T00:00:00.000Z",
      "  policies  at 9, 0 behind",
      "    last failed, resolved 2026-05-02T00:00:00.000Z: Error on OrderPlaced at 7, 1 attempt since 2026-05-01T00:00:00.000Z",
      "  processes  at 9, 0 behind",
      "personal data backfill: sealed through position 9, not caught up yet",
      "forget ledger: not reconciled since this instance started, applied through 2026-04-30T00:00:00.000Z, last run never, held until 2026-05-01T00:05:00.000Z after 2 failures",
      "tenant: acme, key t-2 (older t-1), 1 version left to rewrap under master key m-2",
      "database files",
      "  storage  data/acme.db  encrypted under the tenant's key in force",
      "  readModels.reports  data/reports.db  still under an earlier key of the tenant's: bounda rekey",
      "  readModels.audit  data/audit.db  still in the clear: bounda rekey",
      "key rotation: under k-2 (previous k-1), 1 key left to rewrap",
      "retention",
      "  default  30d, 1 person past it, next due 2026-05-03T00:00:00.000Z",
      "  invoices  6y, 2 keys past it, next due never",
      "  1 key kept past a forgetting that no erasure exemption keeps",
      "dead letter retention: 90s, next purge when a letter is resolved",
      "subscriber failure retention: 30d, next purge 2026-05-04T00:00:00.000Z; 2 failures past it kept while a person it is sealed under is restricted",
      "recipients",
      "  customer.crm  Brevo, third-party, FR: contact, invoices; 1 person disclosed to it",
      "    being told what was recorded before it was declared",
      "  customer.mailer  Mailchimp, processor, US on standard-contractual-clauses: contact; 3 persons disclosed to it",
      "    2 notices failed: bounda dead-letters list --kind recipient --handler customer.mailer",
      "  order.sms  no longer declared, 4 persons disclosed to it",
      "    1 notice failed: bounda dead-letters list --kind recipient --handler order.sms",
    ]);
  });

  it("prints the text of a failure when opened, and says when it went with its person", () => {
    const opened = (errorMessage: string | null): ReadonlyMap<string, SubscriberFailure> =>
      new Map([["projection:orders", { ...failure, errorMessage }]]);
    expect(formatStatus({ status, opened: opened("cannot place for ana") })).toContain(
      "    cannot place for ana\n",
    );
    expect(formatStatus({ status, opened: opened(null) })).toContain(
      "    its text went with the person it was sealed under\n",
    );
  });

  it("says what is not configured, and a rotation that wrapped every key", () => {
    const bare: AppStatus = {
      ...status,
      personalDataBackfill: null,
      forgetLedger: {
        reconciled: true,
        appliedThrough: null,
        lastRunAt: "2026-05-01T00:00:00.000Z",
        held: null,
      },
      tenant: null,
      forgottenTenant: null,
      keyRotation: {
        kid: "k-1",
        previous: [],
        pending: 0,
        completeAt: "2026-05-01T00:00:00.000Z",
        reseal: null,
      },
      retention: null,
      deadLetterRetention: null,
      subscriberFailureRetention: null,
      recipients: [],
      files: [],
    };
    const lines = formatStatus({ status: bare }).split("\n");
    expect(lines.slice(-8)).toEqual([
      "personal data backfill: no personal data marked",
      "forget ledger: reconciled, applied through nothing yet, last run 2026-05-01T00:00:00.000Z",
      "tenant: no keys: no personal data marked",
      "key rotation: under k-1, every key wrapped (checked 2026-05-01T00:00:00.000Z)",
      "retention: no personal data marked",
      "dead letter retention: none kept but the notices of the forgetting, the tenant was forgotten",
      "subscriber failure retention: none kept, the tenant was forgotten",
      "recipients: none declared",
    ]);
    const purging = (held: number, nextDueAt: string | null) =>
      formatStatus({
        status: { ...bare, subscriberFailureRetention: { retentionMs: 90_000, nextDueAt, held } },
      });
    expect(purging(0, null)).toContain(
      "subscriber failure retention: 90s, next purge when a failure is resolved\n",
    );
    expect(purging(1, "2026-05-04T00:00:00.000Z")).toContain(
      "subscriber failure retention: 90s, next purge 2026-05-04T00:00:00.000Z; 1 failure past it kept while a person it is sealed under is restricted\n",
    );
    const letters = (held: number, withoutHandler = 0) =>
      formatStatus({
        status: {
          ...bare,
          deadLetterRetention: {
            retentionMs: 90_000,
            nextDueAt: "2026-05-04T00:00:00.000Z",
            held,
            withoutHandler,
          },
        },
      });
    expect(letters(0)).toContain(
      "dead letter retention: 90s, next purge 2026-05-04T00:00:00.000Z\n",
    );
    expect(letters(2)).toContain(
      "dead letter retention: 90s, next purge 2026-05-04T00:00:00.000Z; 2 letters past it kept while a person it holds data of is restricted\n",
    );
    expect(letters(0, 1)).toContain(
      "dead letter retention: 90s, next purge 2026-05-04T00:00:00.000Z; 1 failed letter of a handler the app no longer runs, kept until discarded: bounda dead-letters list --status failed\n",
    );
    expect(letters(1, 3)).toContain(
      "; 1 letter past it kept while a person it holds data of is restricted; 3 failed letters of a handler",
    );
    const unreadable = formatStatus({
      status: {
        ...bare,
        deadLetterRetention: { retentionMs: 90_000, unreadable: true },
        subscriberFailureRetention: { retentionMs: 90_000, unreadable: true },
      },
    });
    expect(unreadable).toContain(
      "dead letter retention: 90s, its store could not be read, see the logs\n",
    );
    expect(unreadable).toContain(
      "subscriber failure retention: 90s, its store could not be read, see the logs\n",
    );
    expect(
      formatStatus({ status: { ...bare, retention: { categories: [], keptBeyond: 0 } } }),
    ).toContain("retention: not configured\n");
    expect(
      formatStatus({
        status: { ...bare, keyRotation: { ...bare.keyRotation, completeAt: null } as never },
      }),
    ).toContain("key rotation: under k-1, every key wrapped\n");
    const resealing = (reseal: object) =>
      formatStatus({
        status: { ...bare, keyRotation: { ...bare.keyRotation, reseal } as never },
      });
    expect(
      resealing({
        step: "events",
        startedAt: "2026-05-01T00:00:00.000Z",
        completedAt: null,
        superseded: 2,
      }),
    ).toContain("reseal: events since 2026-05-01T00:00:00.000Z, 2 old keys kept\n");
    expect(
      resealing({
        step: "expiring",
        startedAt: "2026-05-01T00:00:00.000Z",
        completedAt: null,
        superseded: 0,
      }),
    ).toContain("reseal: expiring since 2026-05-01T00:00:00.000Z\n");
    expect(
      resealing({
        step: "complete",
        startedAt: null,
        completedAt: "2026-05-02T00:00:00.000Z",
        superseded: 0,
      }),
    ).toContain("reseal: complete (2026-05-02T00:00:00.000Z)\n");
    const tenant = {
      tenant: "acme",
      forgottenAt: null,
      kid: "t-1",
      previous: [],
      master: { kid: "m-1", previous: [], pending: 0 },
    };
    expect(formatStatus({ status: { ...bare, tenant } })).toContain(
      "tenant: acme, key t-1, wrapped under master key m-1\n",
    );
    expect(
      formatStatus({
        status: { ...bare, tenant: { ...tenant, forgottenAt: "2026-05-02T00:00:00.000Z" } },
      }),
    ).toContain("tenant: acme, forgotten at 2026-05-02T00:00:00.000Z\n");
    const forgotten = (forgottenTenant: AppStatus["forgottenTenant"]) =>
      formatStatus({ status: { ...bare, forgottenTenant } }).split("\n");
    expect(forgotten(null).some((line) => line.startsWith("forgotten tenant"))).toBe(false);
    const kept = { fileKeysDestroyed: true };
    expect(forgotten({ ...kept, recipientsTold: false, forgetLedgerCleared: false })).toContain(
      "forgotten tenant: recipients not all told yet, forget ledger not cleared yet, no file key kept; keep the database",
    );
    expect(forgotten({ ...kept, recipientsTold: true, forgetLedgerCleared: false })).toContain(
      "forgotten tenant: recipients told, forget ledger not cleared yet, no file key kept; keep the database",
    );
    expect(forgotten({ ...kept, recipientsTold: true, forgetLedgerCleared: true })).toContain(
      "forgotten tenant: recipients told, forget ledger cleared, no file key kept; the database may be deleted",
    );
    expect(forgotten({ ...kept, recipientsTold: true, forgetLedgerCleared: null })).toContain(
      "forgotten tenant: recipients told, no forget ledger, no file key kept; the database may be deleted",
    );
    expect(forgotten({ ...kept, recipientsTold: false, forgetLedgerCleared: null })).toContain(
      "forgotten tenant: recipients not all told yet, no forget ledger, no file key kept; keep the database",
    );
    expect(
      forgotten({ recipientsTold: true, forgetLedgerCleared: true, fileKeysDestroyed: false }),
    ).toContain(
      "forgotten tenant: recipients told, forget ledger cleared, file keys still kept; keep the database",
    );
    const frozen = (frozenTenant: AppStatus["frozenTenant"]) =>
      formatStatus({ status: { ...bare, frozenTenant } }).split("\n");
    expect(frozen(null).some((line) => line.startsWith("frozen tenant"))).toBe(false);
    expect(frozen({ frozenAt: "2026-05-03T00:00:00.000Z", whole: true })).toContain(
      "frozen tenant: since 2026-05-03T00:00:00.000Z, every store; no write lands until bounda unfreeze-tenant",
    );
    expect(frozen({ frozenAt: "2026-05-03T00:00:00.000Z", whole: false })).toContain(
      "frozen tenant: since 2026-05-03T00:00:00.000Z, but not every store yet: run bounda freeze-tenant again",
    );
    expect(frozen({ unreadable: true })).toContain(
      "frozen tenant: its store could not be read, see the logs",
    );
  });
});

describe("formatStatus of a status with parts that could not be read", () => {
  const UNREADABLE = { unreadable: true } as const;
  const unread: AppStatus = {
    ...status,
    schema: [
      { database: "storage", scope: "storage", version: 2, latest: 2 },
      { database: "readModels.reports", unreadable: true },
    ],
    restoresFound: UNREADABLE,
    lag: {
      lastPosition: 9,
      maxLag: 0,
      subscribers: [
        { subscriber: "projection:orders", unreadable: true },
        { subscriber: "policies", position: 9, lag: 0 },
      ],
      waitingDeadlines: 0,
      forgetLedger: null,
    },
    subscriberFailures: UNREADABLE,
    personalDataBackfill: UNREADABLE,
    forgetLedger: UNREADABLE,
    tenant: UNREADABLE,
    forgottenTenant: UNREADABLE,
    frozenTenant: UNREADABLE,
    keyRotation: UNREADABLE,
    retention: UNREADABLE,
    deadLetterRetention: { retentionMs: 90_000, unreadable: true },
    subscriberFailureRetention: { retentionMs: 90_000, unreadable: true },
    recipients: UNREADABLE,
    files: [],
  };

  it("prints what it read, and says of each other part that its store could not be read", () => {
    expect(formatStatus({ status: unread }).split("\n")).toEqual([
      "tables",
      "  storage  storage  2 of 2",
      "  readModels.reports  its store could not be read, see the logs",
      "restores found while running: its store could not be read, see the logs",
      "subscribers (head at 9)",
      "  projection:orders  its position, its store could not be read, see the logs",
      "  policies  at 9, 0 behind",
      "  last failures: its store could not be read, see the logs",
      "personal data backfill: its store could not be read, see the logs",
      "forget ledger: its store could not be read, see the logs",
      "tenant: its store could not be read, see the logs",
      "forgotten tenant: its store could not be read, see the logs",
      "frozen tenant: its store could not be read, see the logs",
      "key rotation: its store could not be read, see the logs",
      "retention: its store could not be read, see the logs",
      "dead letter retention: 90s, its store could not be read, see the logs",
      "subscriber failure retention: 90s, its store could not be read, see the logs",
      "recipients: its store could not be read, see the logs",
    ]);
  });

  it("says a failure may still hold its subscriber while where it stands could not be read", () => {
    const failures: AppStatus["subscriberFailures"] = [
      { ...failure, current: null },
      {
        ...withoutCode,
        subscriber: "policies",
        resolvedAt: "2026-05-02T00:00:00.000Z",
        current: false,
      },
    ];
    const opened = new Map([["projection:orders", { ...failure, errorMessage: "cannot place" }]]);
    expect(formatStatus({ status: { ...unread, subscriberFailures: failures }, opened })).toContain(
      [
        "  projection:orders  its position, its store could not be read, see the logs",
        "    failed, not resolved: ValidationError (VALIDATION_FAILED) on OrderPlaced at 7, 3 attempts since 2026-05-01T00:00:00.000Z",
        "    cannot place",
        "  policies  at 9, 0 behind",
        "    last failed, resolved 2026-05-02T00:00:00.000Z: ValidationError on OrderPlaced at 7, 3 attempts since 2026-05-01T00:00:00.000Z",
        "personal data backfill",
      ].join("\n"),
    );
    expect(
      formatStatus({
        status: { ...unread, lag: UNREADABLE, subscriberFailures: failures },
        opened,
      }),
    ).toContain(
      [
        "restores found while running: its store could not be read, see the logs",
        "subscribers: where they stand, its store could not be read, see the logs",
        "  projection:orders",
        "    failed, not resolved: ValidationError (VALIDATION_FAILED) on OrderPlaced at 7, 3 attempts since 2026-05-01T00:00:00.000Z",
        "    cannot place",
        "  policies",
        "    last failed, resolved 2026-05-02T00:00:00.000Z: ValidationError on OrderPlaced at 7, 3 attempts since 2026-05-01T00:00:00.000Z",
        "personal data backfill",
      ].join("\n"),
    );
    expect(formatStatus({ status: { ...unread, lag: UNREADABLE } })).toContain(
      [
        "subscribers: where they stand, its store could not be read, see the logs",
        "  last failures: its store could not be read, see the logs",
        "personal data backfill",
      ].join("\n"),
    );
  });
});

describe("formatStatus of the parts it reads", () => {
  it("lists the failures of subscribers the app no longer runs, resolved or not", () => {
    const gone: AppStatus = {
      ...status,
      subscriberFailures: [
        { ...failure, subscriber: "projection:retired", current: false },
        {
          ...withoutCode,
          subscriber: "policies:old",
          resolvedAt: "2026-05-02T00:00:00.000Z",
          current: false,
        },
      ],
    };
    const opened = new Map([["projection:retired", { ...failure, errorMessage: "cannot total" }]]);
    expect(formatStatus({ status: gone, opened })).toContain(
      [
        "  processes  at 9, 0 behind",
        "  projection:retired  no longer run",
        "    last failed, not resolved: ValidationError (VALIDATION_FAILED) on OrderPlaced at 7, 3 attempts since 2026-05-01T00:00:00.000Z",
        "    cannot total",
        "  policies:old  no longer run",
        "    last failed, resolved 2026-05-02T00:00:00.000Z: ValidationError on OrderPlaced at 7, 3 attempts since 2026-05-01T00:00:00.000Z",
        "personal data backfill",
      ].join("\n"),
    );
  });

  it("says a failure its subscriber got past is resolved since, while the store still holds it", () => {
    const past: AppStatus = {
      ...status,
      subscriberFailures: [{ ...failure, subscriber: "policies", current: false }],
    };
    expect(formatStatus({ status: past })).toContain(
      "  policies  at 9, 0 behind\n    last failed, resolved since: ValidationError (VALIDATION_FAILED) on OrderPlaced at 7, 3 attempts since 2026-05-01T00:00:00.000Z\n",
    );
  });

  it("lists every older key and version, a rotation not configured, and keys kept with or without a retention", () => {
    const tenant = {
      tenant: "acme",
      forgottenAt: null,
      kid: "t-3",
      previous: ["t-2", "t-1"],
      master: { kid: "m-1", previous: [], pending: 0 },
    };
    const rotation = {
      kid: "k-3",
      previous: ["k-2", "k-1"],
      pending: 0,
      completeAt: null,
      reseal: null,
    };
    const printed = formatStatus({ status: { ...status, tenant, keyRotation: rotation } });
    expect(printed).toContain(
      "tenant: acme, key t-3 (older t-2, t-1), wrapped under master key m-1\n",
    );
    expect(printed).toContain("key rotation: under k-3 (previous k-2, k-1), every key wrapped\n");
    expect(formatStatus({ status: { ...status, keyRotation: null } })).toContain(
      "key rotation: not configured\n",
    );
    const retention = (categories: number, keptBeyond: number) =>
      formatStatus({
        status: {
          ...status,
          retention: {
            categories: Array.from({ length: categories }, (_, index) => ({
              category: `c-${index}`,
              retention: "1y",
              due: 0,
              nextDueAt: null,
            })),
            keptBeyond,
          },
        },
      }).split("\n");
    const retentionOf = (categories: number, keptBeyond: number) => {
      const lines = retention(categories, keptBeyond);
      const from = lines.findIndex((line) => line.startsWith("retention"));
      return lines.slice(
        from,
        lines.findIndex((line) => line.startsWith("dead letter retention")),
      );
    };
    expect(retentionOf(0, 2)).toEqual([
      "retention",
      "  2 keys kept past a forgetting that no erasure exemption keeps",
    ]);
    expect(retentionOf(1, 0)).toEqual(["retention", "  c-0  1y, 0 keys past it, next due never"]);
    expect(retentionOf(0, 0)).toEqual(["retention: not configured"]);
  });
});

describe("formatSchema", () => {
  it("says so when no database has tables to version", () => {
    expect(formatSchema([])).toBe("  no tables to version");
  });
});

describe("formatRestored", () => {
  it("says how many restores were found, or that the count could not be read", () => {
    expect(formatRestored(3, { counted: true })).toBe(
      "restore recorded: 3 found so far; the background jobs start over from the copy, without the holds it brought back",
    );
    expect(formatRestored({ unreadable: true }, { counted: true })).toBe(
      "restore recorded: how many were found so far, its store could not be read, see the logs; the background jobs start over from the copy, without the holds it brought back",
    );
  });

  it("says nothing was counted, and how to count a copy taken right when the last restore was handled", () => {
    expect(formatRestored(3, { counted: false })).toBe(
      "nothing counted: the database stands exactly where handling the last restore left it, as when this already ran or a start found that restore; if it was restored from a copy taken right then, run bounda restored --again",
    );
  });
});
