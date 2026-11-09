import type { AppStatus, SubscriberFailure } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { formatSchema, formatStatus } from "./status-output.ts";

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
    personalDataBackfill: { position: 9, caughtUp: false },
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
  keyRotation: { kid: "k-2", previous: ["k-1"], pending: 1, completeAt: null },
  retention: { retentionMs: 30 * 86_400_000, due: 1, nextDueAt: "2026-05-03T00:00:00.000Z" },
  deadLetterRetention: { retentionMs: 90_000, nextDueAt: null },
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
      "key rotation: under k-2 (previous k-1), 1 key left to rewrap",
      "retention: 30d, 1 person past it, next due 2026-05-03T00:00:00.000Z",
      "dead letter retention: 90s, next purge when a letter is resolved",
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
      keyRotation: { kid: "k-1", previous: [], pending: 0, completeAt: "2026-05-01T00:00:00.000Z" },
      retention: null,
      deadLetterRetention: null,
    };
    const lines = formatStatus({ status: bare }).split("\n");
    expect(lines.slice(-5)).toEqual([
      "personal data backfill: no personal data marked",
      "forget ledger: reconciled, applied through nothing yet, last run 2026-05-01T00:00:00.000Z",
      "key rotation: under k-1, every key wrapped (checked 2026-05-01T00:00:00.000Z)",
      "retention: not configured",
      "dead letter retention: not configured",
    ]);
    expect(
      formatStatus({
        status: { ...bare, keyRotation: { ...bare.keyRotation, completeAt: null } as never },
      }),
    ).toContain("key rotation: under k-1, every key wrapped\n");
  });
});

describe("formatSchema", () => {
  it("says so when no database has tables to version", () => {
    expect(formatSchema([])).toBe("  no tables to version");
  });
});
