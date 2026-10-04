import { describe, expect, it } from "vitest";
import type { StoragePorts } from "../../adapter/adapter.ts";
import type { DeadLetterErrorType } from "../../adapter/ports/dead-letter-store.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import type { ResolvedRetryConfig } from "../../config/types.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { DomainError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import { runAttempt } from "./reaction-attempt.ts";

const key = { subscriber: "order.p", eventId: "e1" };
const order = { aggregateType: "order", aggregateId: "1" };
const exponential: ResolvedRetryConfig = {
  strategy: "exponential",
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

interface Options {
  readonly retry?: ResolvedRetryConfig;
  readonly concurrencyRetries?: number;
  readonly run?: (unit: UnitOfWork, attempt: number, storage: StoragePorts) => Promise<void>;
}

const setUp = async () => {
  const storage = await memory().createStorage({ logger: silentLogger });
  const clock = createFixedClock();
  const runs: number[] = [];
  const retries: number[] = [];
  const gaveUp: string[] = [];
  const waiting: string[] = [];
  const stage = async (unit: UnitOfWork): Promise<void> => {
    const { version } = await unit.eventStore.load(order);
    await unit.eventStore.append({
      ...order,
      expectedVersion: version,
      events: [pendingEvent({ aggregateId: "1", version: version + 1 })],
    });
  };
  const attempt = ({ retry = exponential, concurrencyRetries = 3, run }: Options = {}) =>
    runAttempt({
      storage,
      key,
      retry,
      leaseMs: 60_000,
      concurrencyRetries,
      clock,
      retries: {
        waiting: (at) => {
          waiting.push(at.toISOString());
        },
        skipToNext: () => false,
      },
      run: async (unit, n) => {
        runs.push(n);
        await (run ?? stage)(unit, n, storage);
      },
      giveUp: async (unit, error, attempts, errorType: DeadLetterErrorType) => {
        await unit.deadLetterStore.add({
          id: `letter-${attempts}`,
          kind: "policy",
          subscriber: key.subscriber,
          eventId: key.eventId,
          eventType: "OrderPlaced",
          aggregateType: "order",
          aggregateId: "1",
          errorType,
          errorMessage: error instanceof Error ? error.message : String(error),
          attempts,
          firstFailedAt: clock.now().toISOString(),
          lastFailedAt: clock.now().toISOString(),
        });
      },
      gaveUp: (attempts, errorType) => {
        gaveUp.push(`${attempts}:${errorType}`);
      },
      willRetry: (attempts) => {
        retries.push(attempts);
      },
    });
  const failing =
    (error: () => unknown) =>
    async (unit: UnitOfWork): Promise<void> => {
      await stage(unit);
      throw error();
    };
  return { storage, clock, runs, retries, gaveUp, waiting, attempt, stage, failing };
};

describe("runAttempt", () => {
  it("runs the reaction once, commits its writes with the claim, and never runs it again", async () => {
    const { storage, runs, attempt } = await setUp();
    expect(await attempt()).toBe("done");
    expect(await attempt()).toBe("done");
    expect(runs).toEqual([1]);
    expect(await storage.eventStore.lastPosition()).toBe(1);
    expect(await storage.inboxLedger.get(key)).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  it("holds while another holder owns the claim", async () => {
    const { storage, clock, runs, attempt } = await setUp();
    await storage.inboxLedger.tryClaim({ ...key, now: clock.now(), leaseMs: 60_000 });
    expect(await attempt()).toBe("hold");
    expect(runs).toEqual([]);
  });

  it("holds a retriable failure, waits out its back-off, and counts the next attempt", async () => {
    const { storage, clock, runs, retries, waiting, attempt, failing } = await setUp();
    expect(await attempt({ run: failing(() => new Error("network")) })).toBe("hold");
    expect(retries).toEqual([1]);
    expect(waiting).toEqual(["2026-01-01T00:00:01.000Z"]);
    expect(await storage.eventStore.lastPosition()).toBe(0);
    expect(await storage.inboxLedger.get(key)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "network",
    });
    clock.advance(999);
    expect(await attempt()).toBe("hold");
    expect(runs).toEqual([1]);
    expect(waiting).toEqual(["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:01.000Z"]);
    clock.advance(1);
    expect(await attempt()).toBe("done");
    expect(runs).toEqual([1, 2]);
    expect(waiting).toHaveLength(2);
    expect(await storage.inboxLedger.get(key)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("gives up on a terminal failure at once, committing the dead letter with the claim and nothing of the run", async () => {
    const { storage, runs, gaveUp, attempt, failing } = await setUp();
    expect(await attempt({ run: failing(() => new DomainError("refused")) })).toBe("done");
    expect(runs).toEqual([1]);
    expect(gaveUp).toEqual(["1:terminal"]);
    expect(await storage.eventStore.lastPosition()).toBe(0);
    expect(await storage.deadLetterStore.count()).toBe(1);
    expect(await storage.inboxLedger.get(key)).toMatchObject({
      status: "succeeded",
      lastError: "refused",
    });
    expect(await attempt()).toBe("done");
    expect(runs).toEqual([1]);
  });

  it("gives up on a retriable failure once it runs out of attempts", async () => {
    const { clock, gaveUp, attempt, failing } = await setUp();
    const retry: ResolvedRetryConfig = { ...exponential, strategy: "fixed", maxAttempts: 2 };
    const run = failing(() => new Error("network"));
    expect(await attempt({ retry, run })).toBe("hold");
    clock.advance(1_000);
    expect(await attempt({ retry, run })).toBe("done");
    expect(gaveUp).toEqual(["2:retriable_exhausted"]);
  });

  it("gives up on the first retriable failure when retries are off", async () => {
    const { gaveUp, attempt, failing } = await setUp();
    const retry: ResolvedRetryConfig = { ...exponential, strategy: "none" };
    expect(await attempt({ retry, run: failing(() => new Error("network")) })).toBe("done");
    expect(gaveUp).toEqual(["1:retriable_exhausted"]);
  });

  it("runs the reaction again on a fresh unit when the commit finds a stream moved, without spending an attempt", async () => {
    const { storage, runs, retries, attempt, stage } = await setUp();
    let raced = false;
    expect(
      await attempt({
        run: async (unit, _n, live) => {
          await stage(unit);
          if (!raced) {
            raced = true;
            await live.eventStore.append({
              ...order,
              expectedVersion: 0,
              events: [pendingEvent({ aggregateId: "1", version: 1, id: "theirs" })],
            });
          }
        },
      }),
    ).toBe("done");
    expect(runs).toEqual([1, 1]);
    expect(retries).toEqual([]);
    const { events } = await storage.eventStore.load(order);
    expect(events.map((event) => event.id)).toEqual(["theirs", "order-1-2"]);
    expect(await storage.inboxLedger.get(key)).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  it("counts a conflict as a retriable failure once the reruns are spent", async () => {
    const { storage, runs, retries, attempt, stage } = await setUp();
    expect(
      await attempt({
        concurrencyRetries: 1,
        run: async (unit, _n, live) => {
          await stage(unit);
          const { version } = await live.eventStore.load(order);
          await live.eventStore.append({
            ...order,
            expectedVersion: version,
            events: [
              pendingEvent({ aggregateId: "1", version: version + 1, id: `theirs-${version}` }),
            ],
          });
        },
      }),
    ).toBe("hold");
    expect(runs).toEqual([1, 1]);
    expect(retries).toEqual([1]);
    expect(await storage.inboxLedger.get(key)).toMatchObject({ status: "failed", attempts: 1 });
  });

  describe("an attempt that meets a conflict", () => {
    const conflicting =
      (stage: (unit: UnitOfWork) => Promise<void>) =>
      async (unit: UnitOfWork, _n: number, live: StoragePorts): Promise<void> => {
        await stage(unit);
        const { version } = await live.eventStore.load(order);
        if (version > 0) return;
        await live.eventStore.append({
          ...order,
          expectedVersion: 0,
          events: [pendingEvent({ aggregateId: "1", version: 1, id: "theirs" })],
        });
      };

    const afterTheConflict = (storage: StoragePorts, then: () => Promise<unknown>): void => {
      const transact = storage.transact.bind(storage);
      storage.transact = async (work) => {
        storage.transact = transact;
        try {
          return await transact(work);
        } catch (error) {
          await then();
          throw error;
        }
      };
    };

    it("stops before running again once another instance took the claim over and committed first", async () => {
      const { storage, clock, runs, retries, gaveUp, attempt, stage } = await setUp();
      afterTheConflict(storage, async () => {
        clock.advance(60_001);
        const claimId = await storage.inboxLedger.tryClaim({
          ...key,
          now: clock.now(),
          leaseMs: 60_000,
        });
        if (claimId === null) throw new Error("claim was not taken over");
        await storage.inboxLedger.complete({ ...key, claimId });
      });

      expect(await attempt({ run: conflicting(stage) })).toBe("hold");

      expect(runs).toEqual([1]);
      expect(retries).toEqual([]);
      expect(gaveUp).toEqual([]);
      const { events } = await storage.eventStore.load(order);
      expect(events.map((event) => event.id)).toEqual(["theirs"]);
      expect(await storage.inboxLedger.get(key)).toMatchObject({
        status: "succeeded",
        attempts: 2,
      });
    });

    it("keeps its claim for the rerun, past the lease it was claimed with", async () => {
      const { storage, clock, runs, attempt, stage } = await setUp();
      afterTheConflict(storage, async () => {
        clock.advance(50_000);
      });
      let takeover: string | null = "not tried";

      expect(
        await attempt({
          run: async (unit, n, live) => {
            await conflicting(stage)(unit, n, live);
            if (runs.length < 2) return;
            clock.advance(20_000);
            takeover = await live.inboxLedger.tryClaim({
              ...key,
              now: clock.now(),
              leaseMs: 60_000,
            });
          },
        }),
      ).toBe("done");

      expect(takeover).toBeNull();
      expect(runs).toEqual([1, 1]);
      expect(await storage.inboxLedger.get(key)).toMatchObject({
        status: "succeeded",
        attempts: 1,
      });
    });

    it("lets a store failure while renewing reach the caller, with the claim still pending", async () => {
      const { storage, runs, retries, gaveUp, attempt, stage } = await setUp();
      afterTheConflict(storage, async () => {
        storage.inboxLedger.renew = async () => {
          throw new Error("connection lost");
        };
      });

      await expect(attempt({ run: conflicting(stage) })).rejects.toThrow("connection lost");

      expect(runs).toEqual([1]);
      expect(retries).toEqual([]);
      expect(gaveUp).toEqual([]);
      expect(await storage.inboxLedger.get(key)).toMatchObject({ status: "pending", attempts: 1 });
    });
  });

  it("lets a store failure at commit reach the caller, with the claim still pending", async () => {
    const { storage, runs, retries, gaveUp, attempt } = await setUp();
    const transact = storage.transact.bind(storage);
    storage.transact = async () => {
      throw new Error("connection lost");
    };
    await expect(attempt()).rejects.toThrow("connection lost");
    storage.transact = transact;
    expect(runs).toEqual([1]);
    expect(retries).toEqual([]);
    expect(gaveUp).toEqual([]);
    expect(await storage.eventStore.lastPosition()).toBe(0);
    expect(await storage.inboxLedger.get(key)).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("holds, writing nothing, when the claim was handed out again before the commit", async () => {
    const { storage, clock, runs, retries, attempt, stage } = await setUp();
    expect(
      await attempt({
        run: async (unit) => {
          await stage(unit);
          clock.advance(60_001);
          await storage.inboxLedger.tryClaim({ ...key, now: clock.now(), leaseMs: 60_000 });
        },
      }),
    ).toBe("hold");
    expect(runs).toEqual([1]);
    expect(retries).toEqual([]);
    expect(await storage.eventStore.lastPosition()).toBe(0);
    expect(await storage.inboxLedger.get(key)).toMatchObject({ status: "pending", attempts: 2 });
  });

  it("commits the give-up with the claim, or neither, and reports it only once committed", async () => {
    const { storage, gaveUp, attempt, failing } = await setUp();
    const transact = storage.transact.bind(storage);
    let broken = true;
    storage.transact = (work) =>
      transact(async (tx) => {
        const result = await work(tx);
        if (broken) {
          broken = false;
          throw new Error("connection lost");
        }
        return result;
      });
    await expect(attempt({ run: failing(() => new DomainError("refused")) })).rejects.toThrow(
      "connection lost",
    );
    expect(gaveUp).toEqual([]);
    expect(await storage.deadLetterStore.count()).toBe(0);
    expect(await storage.inboxLedger.get(key)).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("holds when the claim was handed out again while giving up", async () => {
    const { storage, clock, gaveUp, attempt, stage } = await setUp();
    expect(
      await attempt({
        run: async (unit) => {
          await stage(unit);
          clock.advance(60_001);
          await storage.inboxLedger.tryClaim({ ...key, now: clock.now(), leaseMs: 60_000 });
          throw new DomainError("refused");
        },
      }),
    ).toBe("hold");
    expect(gaveUp).toEqual([]);
    expect(await storage.deadLetterStore.count()).toBe(0);
    expect(await storage.inboxLedger.get(key)).toMatchObject({ status: "pending", attempts: 2 });
  });
});
