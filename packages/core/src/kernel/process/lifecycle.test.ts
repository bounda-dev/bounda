import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../contracts/event.ts";
import { reachedKey } from "./deadlines.ts";
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
      timeoutAt: null,
      reached: new Set(),
      correlationId: null,
      parked: [],
      failure: null,
    });
  });

  it("tracks state, handled events and status through the lifecycle", () => {
    const instance = foldProcess({
      initialState: { reminders: 0 },
      events: [
        lifecycle(
          PROCESS_EVENTS.started,
          { state: { reminders: 0 }, eventId: "e1", timeoutAt: "2026-01-08T00:00:00.000Z" },
          1,
        ),
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
      handledEventIds: new Set(["e2"]),
      timeoutAt: "2026-01-08T00:00:00.000Z",
      reached: new Set(),
      correlationId: "c",
      parked: [],
      failure: null,
    });
  });

  it("only counts handled events with an id and names every lifecycle event", () => {
    const instance = foldProcess({
      initialState: {},
      events: [
        lifecycle(PROCESS_EVENTS.started, { state: {}, eventId: "e1" }, 1),
        lifecycle(PROCESS_EVENTS.handled, { state: { n: 1 } }, 2),
      ],
    });
    expect(instance).toMatchObject({ state: { n: 1 }, handledEventIds: new Set() });
    expect(PROCESS_EVENTS).toEqual({
      started: "ProcessStarted",
      handled: "ProcessHandled",
      deadlineReached: "ProcessDeadlineReached",
      completed: "ProcessCompleted",
      timedOut: "ProcessTimedOut",
      failed: "ProcessFailed",
      eventParked: "ProcessEventParked",
      resumed: "ProcessResumed",
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

  it("records each deadline reached at its moment, whatever its precision, and the deadline a failure was on", () => {
    const instance = foldProcess({
      initialState: {},
      events: [
        lifecycle(PROCESS_EVENTS.started, { state: {}, eventId: "e1" }, 1),
        lifecycle(
          PROCESS_EVENTS.failed,
          { deadline: "nextReminder", at: "2026-01-02T00:00:00Z", error: "boom" },
          2,
        ),
        lifecycle(
          PROCESS_EVENTS.deadlineReached,
          { field: "nextReminder", at: "2026-01-02T00:00:00Z", state: { reminders: 1 } },
          3,
        ),
      ],
    });
    expect(
      foldProcess({
        initialState: {},
        events: [
          lifecycle(PROCESS_EVENTS.started, { state: {}, eventId: "e1" }, 1),
          lifecycle(PROCESS_EVENTS.completed, { eventId: "e2" }, 2),
          lifecycle(PROCESS_EVENTS.deadlineReached, { field: "a", at: "2026-01-02T00:00:00Z" }, 3),
        ],
      }).status,
    ).toBe("completed");
    expect(instance).toMatchObject({
      status: "failed",
      state: { reminders: 1 },
      reached: new Set([reachedKey({ field: "nextReminder", at: "2026-01-02T00:00:00.000Z" })]),
      failure: { deadline: { field: "nextReminder", at: "2026-01-02T00:00:00Z" } },
    });
  });
});

describe("processAggregateType", () => {
  it("prefixes the process type", () => {
    expect(processAggregateType("OrderPayment")).toBe("process:OrderPayment");
  });

  it("keeps a failed process failed, parking events, until it is resumed", () => {
    const failed = foldProcess({
      initialState: {},
      events: [
        lifecycle(PROCESS_EVENTS.started, { state: { step: 0 } }, 1),
        lifecycle(PROCESS_EVENTS.failed, { eventId: "e2", error: "boom" }, 2),
      ],
    });
    expect(failed).toMatchObject({ status: "failed", handledEventIds: new Set() });
    const parked = (eventId: string, version: number) =>
      lifecycle(
        PROCESS_EVENTS.eventParked,
        { eventId, eventType: "OrderPaid", aggregateType: "order", aggregateId: "o-1", extra: 1 },
        version,
      );
    const replaying = [
      lifecycle(PROCESS_EVENTS.started, { state: { step: 0 } }, 1),
      lifecycle(PROCESS_EVENTS.failed, { eventId: "e2", error: "boom" }, 2),
      parked("e3", 3),
      parked("e4", 4),
      lifecycle(PROCESS_EVENTS.handled, { state: { step: 1 }, eventId: "e2" }, 5),
      lifecycle(PROCESS_EVENTS.handled, { state: { step: 2 }, eventId: "e3" }, 6),
    ];
    expect(foldProcess({ initialState: {}, events: replaying })).toMatchObject({
      status: "failed",
      state: { step: 2 },
      handledEventIds: new Set(["e2", "e3"]),
      parked: [
        { eventId: "e4", eventType: "OrderPaid", aggregateType: "order", aggregateId: "o-1" },
      ],
      failure: { eventId: "e2" },
    });
    expect(foldProcess({ initialState: {}, events: replaying }).parked[0]).not.toHaveProperty(
      "extra",
    );
    const resumed = foldProcess({
      initialState: {},
      events: [
        ...replaying,
        lifecycle(PROCESS_EVENTS.handled, { state: { step: 3 }, eventId: "e4" }, 7),
        lifecycle(PROCESS_EVENTS.resumed, {}, 8),
      ],
    });
    expect(resumed).toMatchObject({ status: "started", parked: [], version: 8 });
    const completed = foldProcess({
      initialState: {},
      events: [
        lifecycle(PROCESS_EVENTS.started, { state: { step: 0 } }, 1),
        lifecycle(PROCESS_EVENTS.completed, { eventId: "e2" }, 2),
        lifecycle(PROCESS_EVENTS.handled, { state: { step: 1 }, eventId: "e3" }, 3),
      ],
    });
    expect(completed.status).toBe("completed");
  });
});
