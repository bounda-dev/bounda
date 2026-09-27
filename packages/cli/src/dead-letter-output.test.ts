import type { DeadLetter } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { formatLetter, formatReplayed } from "./dead-letter-output.ts";

const letter: DeadLetter = {
  id: "dl-1",
  kind: "process",
  subscriber: "order.orderPayment",
  eventId: "e-1",
  eventType: "OrderPaid",
  aggregateType: "order",
  aggregateId: "o-1",
  errorType: "terminal",
  errorMessage: "payment provider says no",
  attempts: 1,
  firstFailedAt: "2026-01-01T00:00:00.000Z",
  lastFailedAt: "2026-01-01T00:00:00.000Z",
  status: "failed",
};

describe("dead letter output", () => {
  it("says how many events are parked behind a process failure", () => {
    expect(formatLetter(letter)).toBe(
      [
        "dl-1  failed  process  order.orderPayment",
        "    OrderPaid on order:o-1, 1 attempt, last 2026-01-01T00:00:00.000Z (terminal)",
        "    payment provider says no",
      ].join("\n"),
    );
    expect(formatLetter({ ...letter, parked: 1, attempts: 2 })).toBe(
      [
        "dl-1  failed  process  order.orderPayment",
        "    OrderPaid on order:o-1, 2 attempts, last 2026-01-01T00:00:00.000Z (terminal)",
        "    payment provider says no",
        "    1 event is parked behind it; replaying it handles them in order",
      ].join("\n"),
    );
    expect(formatLetter({ ...letter, parked: 3 })).toContain("3 events are parked behind it");
  });

  it("says when a replay stopped at a parked event that failed the process again", () => {
    const replayed = { ...letter, status: "replayed" as const };
    expect(formatReplayed(replayed)).toBe(
      "replayed dead letter dl-1: process order.orderPayment for OrderPaid",
    );
    expect(formatReplayed({ ...replayed, parked: 2 })).toBe(
      [
        "replayed dead letter dl-1: process order.orderPayment for OrderPaid",
        "the process failed again on a parked event; 2 events are parked behind the new dead letter",
      ].join("\n"),
    );
  });
});
