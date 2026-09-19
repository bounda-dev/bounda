import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../contracts/event.ts";
import { foldProcess, PROCESS_EVENTS, processAggregateType } from "./lifecycle.ts";

const lifecycle = (type: string, payload: unknown, version: number): StoredEvent => ({
  id: `p${version}`,
  aggregateType: "process:OrderPayment",
  aggregateId: "o-1",
  version,
  position: version,
  type,
  payload,
  timestamp: "2026-01-01T00:00:00.000Z",
  metadata: { correlationId: "c", causationId: "c", depth: 0, schemaVersion: 1, system: true },
});

describe("foldProcess", () => {
  it("reports a missing instance as not existing with the initial state", () => {
    expect(foldProcess({ initialState: { reminders: 0 }, events: [] })).toEqual({
      exists: false,
      status: "started",
      state: { reminders: 0 },
      version: 0,
      handledEventIds: new Set(),
    });
  });

  it("tracks state, handled events and status through the lifecycle", () => {
    const instance = foldProcess({
      initialState: { reminders: 0 },
      events: [
        lifecycle(PROCESS_EVENTS.started, { state: { reminders: 0 }, eventId: "e1" }, 1),
        lifecycle(
          PROCESS_EVENTS.handled,
          { state: { reminders: 1 }, eventId: "e2", eventType: "OrderPaid" },
          2,
        ),
        lifecycle(PROCESS_EVENTS.completed, { eventId: "e2" }, 3),
      ],
    });
    expect(instance).toEqual({
      exists: true,
      status: "completed",
      state: { reminders: 1 },
      version: 3,
      handledEventIds: new Set(["e1", "e2"]),
    });
  });

  it("records time-outs with their final state and failures", () => {
    const timedOut = foldProcess({
      initialState: {},
      events: [
        lifecycle(PROCESS_EVENTS.started, { state: {}, eventId: "e1" }, 1),
        lifecycle(PROCESS_EVENTS.timedOut, { state: { reminders: 3 } }, 2),
      ],
    });
    expect(timedOut).toMatchObject({ status: "timed_out", state: { reminders: 3 } });
    const failed = foldProcess({
      initialState: {},
      events: [
        lifecycle(PROCESS_EVENTS.started, { state: {}, eventId: "e1" }, 1),
        lifecycle(PROCESS_EVENTS.failed, { eventId: "e2", error: "boom" }, 2),
      ],
    });
    expect(failed.status).toBe("failed");
  });
});

describe("processAggregateType", () => {
  it("prefixes the process type", () => {
    expect(processAggregateType("OrderPayment")).toBe("process:OrderPayment");
  });
});
