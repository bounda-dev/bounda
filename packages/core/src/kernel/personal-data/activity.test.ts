import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import { isActivity, lastActivity } from "./activity.ts";

const event = (
  position: number,
  aggregateType: string,
  timestamp: string,
  person: string | null = "c-1",
): StoredEvent => ({
  id: `e-${position}`,
  aggregateType,
  aggregateId: "c-1",
  version: position,
  type: "Happened",
  payload: {},
  timestamp,
  metadata: { correlationId: "c", causationId: "c", depth: 0, schemaVersion: 1, system: false },
  person,
  position,
});

describe("isActivity", () => {
  it("counts the events of the app's aggregates, never the runtime's own", () => {
    expect(isActivity(event(1, "customer", "2026-01-01T00:00:00.000Z"))).toBe(true);
    expect(isActivity(event(1, "bounda", "2026-01-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("lastActivity", () => {
  const at = (day: number): string => new Date(Date.UTC(2026, 0, day)).toISOString();

  const stores = (
    events: readonly StoredEvent[],
    row: { lastActiveAt: string | null; position: number } | null,
  ) => {
    const reads: number[] = [];
    return {
      reads,
      persons: {
        get: async () =>
          row === null
            ? null
            : {
                person: "c-1",
                restrictedSince: null,
                forgottenAt: null,
                hold: null,
                ...row,
              },
      },
      eventStore: {
        readByPerson: async ({
          afterPosition,
          limit,
        }: {
          afterPosition: number;
          limit: number;
        }) => {
          reads.push(afterPosition);
          return events.filter((e) => e.position > afterPosition).slice(0, limit);
        },
      },
    };
  };

  it("takes the row's last activity when nothing past it names the person", async () => {
    const { persons, eventStore, reads } = stores([], { lastActiveAt: at(3), position: 7 });
    expect(await lastActivity({ persons, eventStore, person: "c-1", batchSize: 2 })).toBe(at(3));
    expect(reads).toEqual([7]);
  });

  it("reads past the row, page by page, the activity it has not recorded yet, and skips the runtime's own events", async () => {
    const events = [
      event(8, "customer", at(4)),
      event(9, "bounda", at(9)),
      event(10, "order", at(6)),
      event(11, "order", at(5)),
      event(12, "bounda", at(10)),
    ];
    const { persons, eventStore, reads } = stores(events, { lastActiveAt: at(3), position: 7 });
    expect(await lastActivity({ persons, eventStore, person: "c-1", batchSize: 2 })).toBe(at(6));
    expect(reads).toEqual([7, 9, 11]);
  });

  it("keeps the row's activity over older events it has not recorded", async () => {
    const { persons, eventStore } = stores([event(8, "customer", at(1))], {
      lastActiveAt: at(3),
      position: 7,
    });
    expect(await lastActivity({ persons, eventStore, person: "c-1", batchSize: 5 })).toBe(at(3));
  });

  it("reads from the start for a person without a row, and answers null for one never active", async () => {
    const active = stores([event(1, "customer", at(2))], null);
    expect(await lastActivity({ ...active, person: "c-1", batchSize: 5 })).toBe(at(2));
    expect(active.reads).toEqual([0]);
    const idle = stores([event(1, "bounda", at(2))], null);
    expect(await lastActivity({ ...idle, person: "c-1", batchSize: 5 })).toBeNull();
  });

  it("reads a real store by person", async () => {
    const storage = await memory().createStorage();
    expect(
      await lastActivity({
        persons: storage.persons,
        eventStore: storage.eventStore,
        person: "c-1",
        batchSize: 5,
      }),
    ).toBeNull();
  });
});
