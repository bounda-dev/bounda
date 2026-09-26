import { validate, version } from "uuid";
import { describe, expect, it } from "vitest";
import { deriveIdempotencyKey } from "./idempotency-key.ts";

describe("deriveIdempotencyKey", () => {
  it("is a UUID v5 that stays the same for the same handler and subject, across releases too", () => {
    const key = deriveIdempotencyKey({ handler: "order.chargeOnOrderPlaced", subject: "event-1" });
    expect(validate(key)).toBe(true);
    expect(version(key)).toBe(5);
    expect(key).toBe(
      deriveIdempotencyKey({ handler: "order.chargeOnOrderPlaced", subject: "event-1" }),
    );
    expect(key).toBe("cadb92d5-cf88-5a00-a702-8fc518f2fd74");
    expect(
      deriveIdempotencyKey({
        handler: "order.chargeOnOrderPlaced",
        subject: "event-1",
        replay: "r-1",
      }),
    ).toBe("b029fec2-9643-527c-b631-84f4f4820cb1");
  });

  it("changes with the handler, the subject and every replay", () => {
    const keys = new Set([
      deriveIdempotencyKey({ handler: "order.a", subject: "event-1" }),
      deriveIdempotencyKey({ handler: "order.b", subject: "event-1" }),
      deriveIdempotencyKey({ handler: "order.a", subject: "event-2" }),
      deriveIdempotencyKey({ handler: "order.a", subject: "event-1", replay: "r-1" }),
      deriveIdempotencyKey({ handler: "order.a", subject: "event-1", replay: "r-2" }),
    ]);
    expect(keys.size).toBe(5);
  });
});
