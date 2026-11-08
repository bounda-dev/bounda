import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { type Logger, silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { FORGET_LEDGER_WAIT_MS } from "./forget-ledger.ts";
import { withLedgerAppend } from "./ledger-append.ts";

const NOW = new Date("2026-01-01T00:01:00.000Z");

const forgetting = (personId: string, version = 1) =>
  pendingEvent({
    aggregateType: "bounda",
    aggregateId: personId,
    version,
    type: "PersonalDataForgotten",
    id: `f-${personId}-${version}`,
  });

const setUp = async ({
  ledger,
  keepForMs = null,
  logger = silentLogger,
}: {
  readonly ledger?: Partial<ForgetLedger>;
  readonly keepForMs?: number | null;
  readonly logger?: Logger;
} = {}) => {
  const appended: (readonly ForgetLedgerEntry[])[] = [];
  const inner = await memory().createStorage();
  const storage: Storage = withLedgerAppend({
    storage: inner,
    ledger: {
      append: async (entries) => {
        appended.push(entries);
      },
      read: async () => [],
      ...ledger,
    },
    keepForMs,
    clock: createFixedClock(NOW),
    logger,
  });
  return { storage, appended };
};

describe("the append to the forget ledger as a transaction commits", () => {
  it("appends the forgettings a transaction committed, in one call, and nothing else", async () => {
    const { storage, appended } = await setUp();
    const result = await storage.transact(async (transaction) => {
      await transaction.eventStore.append({
        aggregateType: "order",
        aggregateId: "o-1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "o-1", version: 1 })],
      });
      for (const person of ["c-1", "c-2"]) {
        await transaction.eventStore.append({
          aggregateType: "bounda",
          aggregateId: person,
          expectedVersion: 0,
          events: [forgetting(person)],
        });
      }
      return "done";
    });
    expect(result).toBe("done");
    expect(appended).toEqual([
      [
        { personId: "c-1", eventId: "f-c-1-1", forgottenAt: "2026-01-01T00:00:00.000Z" },
        { personId: "c-2", eventId: "f-c-2-1", forgottenAt: "2026-01-01T00:00:00.000Z" },
      ],
    ]);
    await storage.transact(async () => undefined);
    expect(appended).toHaveLength(1);
    await storage.transact((transaction) =>
      transaction.eventStore.reseal([{ position: 1, payload: { total: 9 }, person: "c-9" }]),
    );
    expect(
      await storage.eventStore.readByPerson({ person: "c-9", afterPosition: 0, limit: 1 }),
    ).toMatchObject([{ payload: { total: 9 } }]);
    expect(appended).toHaveLength(1);
  });

  it("appends nothing for a transaction that rolls back, nor for an earlier run of the work", async () => {
    const { storage, appended } = await setUp();
    await expect(
      storage.transact(async (transaction) => {
        await transaction.eventStore.append({
          aggregateType: "bounda",
          aggregateId: "c-1",
          expectedVersion: 0,
          events: [forgetting("c-1")],
        });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(appended).toEqual([]);
    const inner = await memory().createStorage();
    let runs = 0;
    const retrying = withLedgerAppend({
      storage: {
        ...inner,
        // A store that runs the work again on a fresh transaction, as a busy one may.
        transact: async (work) => {
          await inner.transact(work).catch(() => undefined);
          return inner.transact(work);
        },
      },
      ledger: {
        append: async (entries) => {
          appended.push(entries);
        },
        read: async () => [],
      },
      keepForMs: null,
      clock: createFixedClock(NOW),
      logger: silentLogger,
    });
    await retrying.transact(async (transaction) => {
      runs += 1;
      const person = `c-${runs}`;
      await transaction.eventStore.append({
        aggregateType: "bounda",
        aggregateId: person,
        expectedVersion: 0,
        events: [forgetting(person)],
      });
      if (runs === 1) throw new Error("busy");
    });
    expect(appended.map((entries) => entries.map(({ personId }) => personId))).toEqual([["c-2"]]);
  });

  it("leaves out a forgetting older than keepFor", async () => {
    const { storage, appended } = await setUp({ keepForMs: 60_000 });
    await storage.transact((transaction) =>
      transaction.eventStore.append({
        aggregateType: "bounda",
        aggregateId: "c-1",
        expectedVersion: 0,
        events: [forgetting("c-1")],
      }),
    );
    expect(appended).toEqual([]);
    const { storage: fresh, appended: kept } = await setUp({ keepForMs: 60_001 });
    await fresh.transact((transaction) =>
      transaction.eventStore.append({
        aggregateType: "bounda",
        aggregateId: "c-1",
        expectedVersion: 0,
        events: [forgetting("c-1")],
      }),
    );
    expect(kept).toHaveLength(1);
  });

  it("logs a ledger that refuses the forgetting and resolves what the transaction did", async () => {
    const warnings: unknown[] = [];
    const { storage } = await setUp({
      ledger: {
        append: async () => {
          throw new Error("ledger is down");
        },
      },
      logger: { ...silentLogger, warn: (message, fields) => warnings.push([message, fields]) },
    });
    const result = await storage.transact(async (transaction) => {
      await transaction.eventStore.append({
        aggregateType: "bounda",
        aggregateId: "c-1",
        expectedVersion: 0,
        events: [forgetting("c-1")],
      });
      return "committed";
    });
    expect(result).toBe("committed");
    expect(warnings).toEqual([
      [
        "forget ledger did not take the forgetting; the stream copies it",
        expect.objectContaining({
          forgotten: 1,
          error: expect.objectContaining({ message: "ledger is down" }),
        }),
      ],
    ]);
  });

  it("leaves forgettings to the stream while an append that did not answer in time is pending", async () => {
    const inner = await memory().createStorage();
    const clock = createFixedClock(NOW);
    let answer: () => void = () => undefined;
    const appends: string[][] = [];
    const storage = withLedgerAppend({
      storage: inner,
      ledger: {
        append: (entries) => {
          appends.push(entries.map(({ personId }) => personId));
          return appends.length === 1
            ? new Promise<void>((resolve) => {
                answer = resolve;
              })
            : Promise.resolve();
        },
        read: async () => [],
      },
      keepForMs: null,
      clock,
      logger: silentLogger,
    });
    const forget = (person: string) =>
      storage.transact((transaction) =>
        transaction.eventStore.append({
          aggregateType: "bounda",
          aggregateId: person,
          expectedVersion: 0,
          events: [forgetting(person)],
        }),
      );
    let done = false;
    const first = forget("c-1").then(() => {
      done = true;
    });
    while (!done) {
      clock.advance(FORGET_LEDGER_WAIT_MS);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await first;
    await forget("c-2");
    expect(appends).toEqual([["c-1"]]);
    answer();
    await new Promise((resolve) => setTimeout(resolve, 1));
    await forget("c-3");
    expect(appends).toEqual([["c-1"], ["c-3"]]);
  });

  it("reads through the transaction's event store as it is", async () => {
    const { storage } = await setUp();
    await storage.transact(async (transaction) => {
      await transaction.eventStore.append({
        aggregateType: "order",
        aggregateId: "o-1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "o-1", version: 1 })],
      });
      const loaded = await transaction.eventStore.load({
        aggregateType: "order",
        aggregateId: "o-1",
      });
      expect(loaded.version).toBe(1);
    });
    const { eventStore } = await storage.transact(async (transaction) => transaction);
    expect(
      await eventStore.readOne({
        aggregateType: "order",
        aggregateId: "o-1",
        eventId: "order-o-1-1",
      }),
    ).toMatchObject({ id: "order-o-1-1" });
    expect(await eventStore.lastPosition()).toBe(1);
    expect(await eventStore.readAll({ afterPosition: 0, limit: 10 })).toHaveLength(1);
    expect(await eventStore.readByPerson({ afterPosition: 0, limit: 10, person: "c-1" })).toEqual(
      [],
    );
  });
});
