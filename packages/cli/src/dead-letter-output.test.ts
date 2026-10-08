import type { DeadLetter } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { formatLetter, formatRetried } from "./dead-letter-output.ts";

const letter: DeadLetter = {
  id: "dl-1",
  kind: "process",
  handler: "order.orderPayment",
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
        "    1 event is parked behind it; retrying it handles them in order",
      ].join("\n"),
    );
    expect(formatLetter({ ...letter, parked: 3 })).toContain("3 events are parked behind it");
    expect(formatLetter({ ...letter, eventId: "deadline:timeout", parked: 2 })).toContain(
      "2 events are parked behind it; retrying it times the process out and drops them",
    );
  });

  it("says when a retry stopped because the process failed again", () => {
    const retried = { ...letter, status: "retried" as const };
    expect(formatRetried(retried)).toBe(
      "retried dead letter dl-1: process order.orderPayment for OrderPaid",
    );
    expect(formatRetried({ ...retried, parked: 2 })).toBe(
      [
        "retried dead letter dl-1: process order.orderPayment for OrderPaid",
        "the process failed again; 2 steps still wait, starting with the new dead letter",
      ].join("\n"),
    );
    expect(formatRetried({ ...retried, parked: 1 })).toContain("1 step still waits");
  });
});
