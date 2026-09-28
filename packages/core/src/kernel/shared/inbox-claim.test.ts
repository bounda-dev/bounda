import { describe, expect, it } from "vitest";
import type { DeadLetterErrorType } from "../../adapter/ports/dead-letter-store.ts";
import type { ResolvedRetryConfig } from "../../config/types.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { DomainError } from "../../contracts/errors.ts";
import { createMemoryInboxLedger } from "../../memory/inbox-ledger.ts";
import { runClaimed } from "./inbox-claim.ts";

const key = { subscriber: "order.notify", eventId: "e-1" };

const retry: ResolvedRetryConfig = {
  strategy: "fixed",
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 1_000,
};

const setUp = (config: ResolvedRetryConfig = retry) => {
  const ledger = createMemoryInboxLedger();
  const clock = createFixedClock();
  const attempts: number[] = [];
  const givenUp: [number, DeadLetterErrorType][] = [];
  const reasons: unknown[] = [];
  const retried: number[] = [];
  let giveUpFails = false;
  const claim = (run: (attempt: number) => Promise<void>) =>
    runClaimed({
      ledger,
      key,
      retry: config,
      leaseMs: 60_000,
      clock,
      run: async (attempt) => {
        attempts.push(attempt);
        await run(attempt);
      },
      giveUp: async (error, attempt, errorType) => {
        givenUp.push([attempt, errorType]);
        reasons.push(error);
        if (giveUpFails) {
          giveUpFails = false;
          throw new Error("dead letters unavailable");
        }
      },
      willRetry: (attempt) => {
        retried.push(attempt);
      },
    });
  const failGiveUpOnce = (): void => {
    giveUpFails = true;
  };
  return { ledger, clock, attempts, givenUp, reasons, retried, claim, failGiveUpOnce };
};

const fail = (error: unknown) => async (): Promise<void> => {
  throw error;
};

describe("runClaimed", () => {
  it("runs once, completes the claim, and never runs again", async () => {
    const { ledger, attempts, claim } = setUp();

    expect(await claim(async () => undefined)).toBe("done");
    expect(await claim(async () => undefined)).toBe("done");

    expect(attempts).toEqual([1]);
    expect(await ledger.get(key)).toMatchObject({ status: "succeeded" });
  });

  it("holds while another holder owns the claim", async () => {
    const { ledger, clock, attempts, claim } = setUp();
    await ledger.tryClaim({ ...key, now: clock.now(), leaseMs: 60_000 });

    expect(await claim(async () => undefined)).toBe("hold");
    expect(attempts).toEqual([]);
  });

  it("holds a retriable failure, waits out its back-off, and counts the next attempt", async () => {
    const { ledger, clock, attempts, givenUp, retried, claim } = setUp();

    expect(await claim(fail(new Error("down")))).toBe("hold");
    expect(await ledger.get(key)).toMatchObject({ status: "failed", lastError: "down" });
    expect(retried).toEqual([1]);

    clock.advance(999);
    expect(await claim(async () => undefined)).toBe("hold");
    expect(attempts).toEqual([1]);

    clock.advance(1);
    expect(await claim(async () => undefined)).toBe("done");
    expect(attempts).toEqual([1, 2]);
    expect(givenUp).toEqual([]);
  });

  it("gives up on a terminal failure at once and completes the claim", async () => {
    const { ledger, givenUp, retried, claim } = setUp();

    expect(await claim(fail(new DomainError("refused")))).toBe("done");

    expect(givenUp).toEqual([[1, "terminal"]]);
    expect(retried).toEqual([]);
    expect(await ledger.get(key)).toMatchObject({ status: "succeeded" });
  });

  it("gives up on a retriable failure once it runs out of attempts", async () => {
    const { ledger, clock, givenUp, retried, claim } = setUp();

    expect(await claim(fail(new Error("down")))).toBe("hold");
    clock.advance(1_000);
    expect(await claim(fail(new Error("down")))).toBe("hold");
    clock.advance(1_000);
    expect(await claim(fail(new Error("down")))).toBe("done");

    expect(retried).toEqual([1, 2]);
    expect(givenUp).toEqual([[3, "retriable_exhausted"]]);
    expect(await ledger.get(key)).toMatchObject({ status: "succeeded", lastError: "down" });
  });

  it("gives up on the first retriable failure when retries are off", async () => {
    const { givenUp, retried, claim } = setUp({ ...retry, strategy: "none" });

    expect(await claim(fail(new Error("down")))).toBe("done");

    expect(givenUp).toEqual([[1, "retriable_exhausted"]]);
    expect(retried).toEqual([]);
  });

  it("gives up again without running when giving up on the last attempt threw", async () => {
    const { ledger, attempts, givenUp, reasons, claim, failGiveUpOnce } = setUp({
      ...retry,
      strategy: "none",
    });
    failGiveUpOnce();

    await expect(claim(fail(new Error("down")))).rejects.toThrow("dead letters unavailable");
    expect(await claim(async () => undefined)).toBe("done");

    expect(attempts).toEqual([1]);
    expect(givenUp).toEqual([
      [1, "retriable_exhausted"],
      [1, "retriable_exhausted"],
    ]);
    expect(reasons.at(-1)).toBe("down");
    expect(await ledger.get(key)).toMatchObject({ status: "succeeded" });
  });

  it("leaves a claim that failed its last attempt to whoever claims it first", async () => {
    const { ledger, givenUp, claim, failGiveUpOnce } = setUp({ ...retry, strategy: "none" });
    failGiveUpOnce();
    await expect(claim(fail(new Error("down")))).rejects.toThrow("dead letters unavailable");
    ledger.tryClaim = async () => false;

    expect(await claim(async () => undefined)).toBe("hold");
    expect(givenUp).toHaveLength(1);
  });

  it("gives up on a terminal failure again without running when giving up threw", async () => {
    const { ledger, attempts, givenUp, reasons, claim, failGiveUpOnce } = setUp();
    failGiveUpOnce();
    await expect(claim(fail(new DomainError("refused")))).rejects.toThrow(
      "dead letters unavailable",
    );
    expect(await ledger.get(key)).toMatchObject({ status: "failed", gaveUp: "terminal" });

    expect(await claim(async () => undefined)).toBe("done");

    expect(attempts).toEqual([1]);
    expect(givenUp).toEqual([
      [1, "terminal"],
      [1, "terminal"],
    ]);
    expect(reasons.at(-1)).toBe("refused");
    expect(await ledger.get(key)).toMatchObject({ status: "succeeded" });
  });
});
