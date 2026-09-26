import { validate, version } from "uuid";
import { describe, expect, it } from "vitest";
import { deriveIdempotencyKey } from "./idempotency-key.ts";

describe("deriveIdempotencyKey", () => {
  it("is a UUID v5 that stays the same for the same handler and subject, across releases too", () => {
    const key = deriveIdempotencyKey({
      kind: "policy",
      handler: "order.chargeOnOrderPlaced",
      subject: "event-1",
    });
    expect(validate(key)).toBe(true);
    expect(version(key)).toBe(5);
    expect(key).toBe(
      deriveIdempotencyKey({
        kind: "policy",
        handler: "order.chargeOnOrderPlaced",
        subject: "event-1",
      }),
    );
    expect(key).toBe("1edcd2b1-8ce9-5d44-8c3b-6b9bb156e6e1");
    expect(
      deriveIdempotencyKey({
        kind: "policy",
        handler: "order.chargeOnOrderPlaced",
        subject: "event-1",
        replay: "r-1",
      }),
    ).toBe("1d7dde3c-e21d-5f8d-babe-5ea49ebdfa6b");
  });

  it("changes with the kind, the handler, the subject and every replay", () => {
    const keys = new Set([
      deriveIdempotencyKey({ kind: "policy", handler: "order.a", subject: "event-1" }),
      deriveIdempotencyKey({ kind: "policy", handler: "order.b", subject: "event-1" }),
      deriveIdempotencyKey({ kind: "policy", handler: "order.a", subject: "event-2" }),
      deriveIdempotencyKey({ kind: "process", handler: "order.a", subject: "event-1" }),
      deriveIdempotencyKey({
        kind: "policy",
        handler: "order.a",
        subject: "event-1",
        replay: "r-1",
      }),
      deriveIdempotencyKey({
        kind: "policy",
        handler: "order.a",
        subject: "event-1",
        replay: "r-2",
      }),
    ]);
    expect(keys.size).toBe(6);
  });
});
