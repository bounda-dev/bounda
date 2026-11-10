import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import { withCommittedEvents } from "./committed-events.ts";

const setUp = async (wrap: (storage: Storage) => Storage = (storage) => storage) => {
  const committed: string[][] = [];
  const inner = await memory().createStorage();
  const storage = withCommittedEvents({
    storage: wrap(inner),
    committed: (events: readonly StoredEvent[]) => {
      committed.push(events.map(({ id }) => id));
    },
  });
  return { storage, committed };
};

const append = (aggregateId: string, version = 1) => ({
  aggregateType: "order",
  aggregateId,
  expectedVersion: version - 1,
  events: [pendingEvent({ aggregateId, version, id: `${aggregateId}-${version}` })],
});

describe("withCommittedEvents", () => {
  it("reports the events of an append outside a transaction once it resolved", async () => {
    const { storage, committed } = await setUp();
    await storage.eventStore.append(append("o-1"));
    expect(committed).toEqual([["o-1-1"]]);
  });

  it("reports the events of a transaction once it committed, together, and nothing for one without", async () => {
    const { storage, committed } = await setUp();
    const result = await storage.transact(async (transaction) => {
      await transaction.eventStore.append(append("o-1"));
      await transaction.eventStore.append(append("o-2"));
      expect(committed).toEqual([]);
      return "done";
    });
    expect(result).toBe("done");
    expect(committed).toEqual([["o-1-1", "o-2-1"]]);
    await storage.transact(async () => undefined);
    expect(committed).toHaveLength(1);
  });

  it("reports nothing for a transaction that rolls back, nor for an earlier run of the work", async () => {
    const { storage, committed } = await setUp();
    await expect(
      storage.transact(async (transaction) => {
        await transaction.eventStore.append(append("o-1"));
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(committed).toEqual([]);
    let runs = 0;
    const { storage: retrying, committed: once } = await setUp((inner) => ({
      ...inner,
      // A store that runs the work again on a fresh transaction, as a busy one may.
      transact: async (work) => {
        await inner.transact(work).catch(() => undefined);
        return inner.transact(work);
      },
    }));
    await retrying.transact(async (transaction) => {
      runs += 1;
      await transaction.eventStore.append(append(`o-${runs}`));
      if (runs === 1) throw new Error("busy");
    });
    expect(once).toEqual([["o-2-1"]]);
  });

  it("reads and reseals through the store as it is", async () => {
    const { storage } = await setUp();
    await storage.eventStore.append(append("o-1"));
    await storage.transact(async (transaction) => {
      await transaction.eventStore.reseal([{ position: 1, payload: { total: 9 }, person: "c-9" }]);
      expect(await transaction.eventStore.lastPosition()).toBe(1);
      expect(
        await transaction.eventStore.readOne({
          aggregateType: "order",
          aggregateId: "o-1",
          eventId: "o-1-1",
        }),
      ).not.toBeNull();
      expect(await transaction.eventStore.readAll({ afterPosition: 0, limit: 1 })).toHaveLength(1);
      expect(
        await transaction.eventStore.readByPerson({ person: "c-1", afterPosition: 0, limit: 1 }),
      ).toEqual([]);
      expect(
        (await transaction.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })).events,
      ).toHaveLength(1);
    });
    expect(await storage.eventStore.lastPosition()).toBe(1);
    expect(
      await storage.eventStore.readByPerson({ person: "c-9", afterPosition: 0, limit: 1 }),
    ).toHaveLength(1);
    expect(await storage.eventStore.readAll({ afterPosition: 0, limit: 1 })).toHaveLength(1);
    expect(
      await storage.eventStore.readOne({
        aggregateType: "order",
        aggregateId: "o-1",
        eventId: "o-1-1",
      }),
    ).not.toBeNull();
    expect(
      (await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })).events,
    ).toHaveLength(1);
    await storage.eventStore.reseal([{ position: 1, payload: { total: 8 }, person: "c-9" }]);
    expect(
      await storage.eventStore.readOne({
        aggregateType: "order",
        aggregateId: "o-1",
        eventId: "o-1-1",
      }),
    ).toMatchObject({ payload: { total: 8 } });
  });
});
