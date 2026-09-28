import { validate, version } from "uuid";
import { describe, expect, it } from "vitest";
import {
  createReactionCommandIds,
  deriveDeadLetterId,
  deriveIdempotencyKey,
} from "./idempotency-key.ts";

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

describe("createReactionCommandIds", () => {
  it("gives a retried run the same ids, counting each command type on its own", () => {
    const first = createReactionCommandIds("key-1");
    const retry = createReactionCommandIds("key-1");
    const ids = [first("PayOrder"), first("ArchiveOrder"), first("PayOrder")];
    expect([retry("PayOrder"), retry("ArchiveOrder"), retry("PayOrder")]).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
    expect([ids[0], ids[2]]).toEqual([
      "2aa18bbe-6bed-5e09-a3dc-de0443b0d21e",
      "7fdeee67-e286-5473-90cf-60b1230f34bf",
    ]);
    expect(ids.every((id) => version(id) === 5)).toBe(true);
    expect(createReactionCommandIds("key-2")("PayOrder")).not.toBe(ids[0]);
  });

  it("does not let a retry that decides differently reuse the id of another command", () => {
    const first = createReactionCommandIds("key-1");
    const retry = createReactionCommandIds("key-1");
    expect(retry("RecordPaymentFailure")).not.toBe(first("RecordPayment"));
  });
});

describe("deriveDeadLetterId", () => {
  const args = {
    kind: "policy",
    handler: "order.chargeOnOrderPlaced",
    subject: "event-1",
  } as const;

  it("is a UUID v5 that stays the same for one reaction to one event, across releases too", () => {
    const id = deriveDeadLetterId(args);
    expect(validate(id)).toBe(true);
    expect(version(id)).toBe(5);
    expect(deriveDeadLetterId({ ...args })).toBe(id);
    expect(id).toBe("c36aded5-457b-5339-b550-f16bfbfe8fb4");
  });

  it("changes with the kind, the handler and the event, and is never the idempotency key", () => {
    const id = deriveDeadLetterId(args);
    expect(
      new Set([
        id,
        deriveDeadLetterId({ ...args, kind: "process" }),
        deriveDeadLetterId({ ...args, handler: "order.notifyOnOrderPlaced" }),
        deriveDeadLetterId({ ...args, subject: "event-2" }),
        deriveIdempotencyKey(args),
      ]).size,
    ).toBe(5);
  });
});
