import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../contracts/event.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { reachedKey } from "./deadlines.ts";
import {
  deadlineContext,
  type FoldProcessArgs,
  foldProcess,
  instanceContext,
  PROCESS_EVENTS,
  processAggregateType,
} from "./lifecycle.ts";

const lifecycle = (
  type: string,
  payload: unknown,
  version: number,
  correlationId = "c",
): StoredEvent => ({
  id: `p${version}`,
  aggregateType: "process:order.orderPayment",
  aggregateId: "o-1",
  version,
  position: version,
  type,
  payload,
  timestamp: "2026-01-01T00:00:00.000Z",
  metadata: { correlationId, causationId: "c", depth: 0, schemaVersion: 1, system: true },
});

const fold = (args: Omit<FoldProcessArgs, "deadlineFields">) =>
  foldProcess({ ...args, deadlineFields: [] });

describe("foldProcess", () => {
  it("reports a missing instance as not existing with the initial state", () => {
    expect(fold({ initialState: { reminders: 0 }, events: [] })).toEqual({
      exists: false,
      status: "started",
      state: { reminders: 0 },
      version: 0,
      handledEventIds: new Set(),
      timeoutAt: null,
      reached: new Set(),
      correlationId: null,
      deadlineCauses: new Map(),
      parked: [],
      followUps: new Set(),
      failure: null,
    });
  });

  it("tracks state, handled events and status through the lifecycle", () => {
    const instance = fold({
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
      deadlineCauses: new Map([
        [
          reachedKey({ field: "timeout", at: "2026-01-08T00:00:00.000Z" }),
          { correlationId: "c", causationId: "p1" },
        ],
      ]),
      parked: [],
      followUps: new Set(),
      failure: null,
    });
  });

  it("only counts handled events with an id and names every lifecycle event", () => {
    const instance = fold({
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

  it("leads each deadline at each moment to the step that set it, under that step's correlation", () => {
    const at = (day: number): string => `2026-01-0${day}T00:00:00.000Z`;
    const cause = (version: number, correlationId = "c") => ({
      correlationId,
      causationId: `p${version}`,
    });
    const causes = (events: readonly StoredEvent[]) =>
      foldProcess({
        deadlineFields: ["a", "b", "c"],
        initialState: { a: null, b: null, c: at(5), n: 0 },
        events,
      }).deadlineCauses;
    const started = lifecycle(
      PROCESS_EVENTS.started,
      { state: { a: null, b: null, c: at(5), n: 0 }, eventId: "e1", timeoutAt: at(9) },
      1,
    );
    const placed = lifecycle(
      PROCESS_EVENTS.handled,
      { state: { a: at(2), b: at(3), c: at(5), n: 1 }, eventId: "e1" },
      2,
    );
    expect(causes([started, placed])).toEqual(
      new Map([
        [reachedKey({ field: "c", at: at(5) }), cause(1)],
        [reachedKey({ field: "timeout", at: at(9) }), cause(1)],
        [reachedKey({ field: "a", at: at(2) }), cause(2)],
        [reachedKey({ field: "b", at: at(3) }), cause(2)],
      ]),
    );
    const later = causes([
      started,
      placed,
      lifecycle(
        PROCESS_EVENTS.handled,
        { state: { a: "2026-01-02T00:00:00Z", b: at(3), c: at(5), n: 2 }, eventId: "e2" },
        3,
        "other",
      ),
      lifecycle(
        PROCESS_EVENTS.deadlineReached,
        { field: "a", at: at(2), state: { a: at(4), b: null, c: at(5), n: 2 } },
        4,
      ),
      lifecycle(PROCESS_EVENTS.handled, { eventId: "e3" }, 5),
      lifecycle(
        PROCESS_EVENTS.handled,
        { state: { a: at(4), b: at(3), c: "soon", n: 3 }, eventId: "e4" },
        6,
        "other",
      ),
      lifecycle(
        PROCESS_EVENTS.handled,
        { state: { a: at(4), b: at(3), c: "soon", n: 4 }, eventId: "e5" },
        7,
      ),
    ]);
    expect(later.get(reachedKey({ field: "a", at: at(2) }))).toEqual(cause(2));
    expect(later.get(reachedKey({ field: "a", at: at(4) }))).toEqual(cause(4));
    expect(later.get(reachedKey({ field: "b", at: at(3) }))).toEqual(cause(6, "other"));
    expect(later.get(reachedKey({ field: "c", at: "soon" }))).toEqual(cause(6, "other"));
  });

  it("follows the deadlines an at-timeout step sets", () => {
    const instance = foldProcess({
      deadlineFields: ["a"],
      initialState: { a: null },
      events: [
        lifecycle(PROCESS_EVENTS.started, { state: { a: null }, eventId: "e1" }, 1),
        lifecycle(PROCESS_EVENTS.timedOut, { state: { a: "2026-01-02T00:00:00.000Z" } }, 2),
      ],
    });
    expect(instance.deadlineCauses).toEqual(
      new Map([
        [
          reachedKey({ field: "a", at: "2026-01-02T00:00:00.000Z" }),
          { correlationId: "c", causationId: "p2" },
        ],
      ]),
    );
  });

  it("keeps the follow-ups of a time-out pending until each is handled, still timed out", () => {
    const instance = fold({
      initialState: {},
      events: [
        lifecycle(PROCESS_EVENTS.started, { state: {}, eventId: "e1" }, 1),
        lifecycle(PROCESS_EVENTS.timedOut, { state: { n: 1 }, followUps: ["e2", "e3"] }, 2),
        lifecycle(PROCESS_EVENTS.handled, { state: { n: 2 }, eventId: "e2" }, 3),
      ],
    });
    expect(instance).toMatchObject({
      status: "timed_out",
      state: { n: 2 },
      handledEventIds: new Set(["e2"]),
      followUps: new Set(["e3"]),
    });
  });

  it("records time-outs with their final state and failures", () => {
    const timedOut = fold({
      initialState: {},
      events: [
        lifecycle(PROCESS_EVENTS.started, { state: {}, eventId: "e1" }, 1),
        lifecycle(PROCESS_EVENTS.timedOut, { state: { reminders: 3 } }, 2),
      ],
    });
    expect(timedOut).toMatchObject({
      status: "timed_out",
      state: { reminders: 3 },
      followUps: new Set(),
    });
    const failed = fold({
      initialState: {},
      events: [
        lifecycle(PROCESS_EVENTS.started, { state: {}, eventId: "e1" }, 1),
        lifecycle(PROCESS_EVENTS.failed, { eventId: "e2", error: "boom" }, 2),
      ],
    });
    expect(failed.status).toBe("failed");
  });

  it("records each deadline reached at its moment, whatever its precision, and the deadline a failure was on", () => {
    const instance = fold({
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
      fold({
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
    expect(processAggregateType("order.orderPayment")).toBe("process:order.orderPayment");
  });

  it("keeps a failed process failed, parking events, until it is resumed", () => {
    const failed = fold({
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
    const retrying = [
      lifecycle(PROCESS_EVENTS.started, { state: { step: 0 } }, 1),
      lifecycle(PROCESS_EVENTS.failed, { eventId: "e2", error: "boom" }, 2),
      parked("e3", 3),
      parked("e4", 4),
      lifecycle(PROCESS_EVENTS.handled, { state: { step: 1 }, eventId: "e2" }, 5),
      lifecycle(PROCESS_EVENTS.handled, { state: { step: 2 }, eventId: "e3" }, 6),
    ];
    expect(fold({ initialState: {}, events: retrying })).toMatchObject({
      status: "failed",
      state: { step: 2 },
      handledEventIds: new Set(["e2", "e3"]),
      parked: [
        { eventId: "e4", eventType: "OrderPaid", aggregateType: "order", aggregateId: "o-1" },
      ],
      failure: { eventId: "e2" },
    });
    expect(fold({ initialState: {}, events: retrying }).parked[0]).not.toHaveProperty("extra");
    const resumed = fold({
      initialState: {},
      events: [
        ...retrying,
        lifecycle(PROCESS_EVENTS.handled, { state: { step: 3 }, eventId: "e4" }, 7),
        lifecycle(PROCESS_EVENTS.resumed, {}, 8),
      ],
    });
    expect(resumed).toMatchObject({ status: "started", parked: [], version: 8 });
    const completed = fold({
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

describe("deadlineContext", () => {
  const process: ProcessRuntime = {
    name: "order.orderPayment",
    aggregate: "order",
    startedBy: new Set(["OrderPlaced"]),
    completedBy: new Set(["OrderPaid"]),
    lifetimeMs: 60_000,
    handlerTimeoutMs: 30_000,
    initialState: {},
    stateSchema: null,
    handlers: {},
    deadlineFields: [],
    deadlineHandlers: {},
    ports: {},
    instanceOf: (event) => event.aggregateId,
  };

  it("puts a deadline under the event that set it at its moment, and under the instance when none did", () => {
    const timeoutAt = "2026-01-08T00:00:00.000Z";
    const instance = fold({
      initialState: {},
      events: [lifecycle(PROCESS_EVENTS.started, { state: {}, eventId: "e1", timeoutAt }, 1, "c1")],
    });
    expect(deadlineContext(process, "o-1", instance, { field: "timeout", at: timeoutAt })).toEqual({
      correlationId: "c1",
      causationId: "p1",
      depth: 0,
    });
    expect(
      deadlineContext(process, "o-1", instance, {
        field: "timeout",
        at: "2026-01-09T00:00:00.000Z",
      }),
    ).toEqual(instanceContext(process, "o-1", instance));
    expect(instanceContext(process, "o-1", instance)).toEqual({
      correlationId: "c1",
      causationId: "process:order.orderPayment:o-1",
      depth: 0,
    });
  });
});
