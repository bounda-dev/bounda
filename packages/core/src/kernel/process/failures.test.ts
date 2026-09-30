import { afterEach, describe, expect, it } from "vitest";
import type { NewDeadLetter } from "../../adapter/ports/dead-letter-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { DomainError, ValidationError } from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { type FakeTelemetry, installFakeTelemetry } from "../telemetry-fake.ts";
import { createRecordingLogger } from "../test-support.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { blockedOn, createProcessFailures, deadlineSubject, drainFailureType } from "./failures.ts";
import type { ProcessInstance } from "./lifecycle.ts";

const orderPayment: ProcessRuntime = {
  name: "orderPayment",
  type: "OrderPayment",
  aggregate: "order",
  startedBy: new Set(["OrderPlaced"]),
  completedBy: new Set(["OrderPaid"]),
  timeoutMs: 60_000,
  initialState: {},
  stateSchema: null,
  handlers: {},
  deadlineFields: [],
  deadlineHandlers: {},
  collaborators: {},
  instanceOf: (event) => event.aggregateId,
};

const subject = {
  id: "e-1",
  type: "OrderPlaced",
  aggregateType: "order",
  aggregateId: "o-1",
};

const letter: NewDeadLetter = {
  id: "letter-1",
  kind: "process",
  subscriber: "orderPayment",
  eventId: "e-1",
  eventType: "OrderPlaced",
  aggregateType: "order",
  aggregateId: "o-1",
  errorType: "terminal",
  errorMessage: "boom",
  attempts: 1,
  firstFailedAt: "2026-01-01T00:00:00.000Z",
  lastFailedAt: "2026-01-01T00:00:00.000Z",
};

const instance = (overrides: Partial<ProcessInstance> = {}): ProcessInstance => ({
  exists: true,
  status: "failed",
  state: {},
  version: 2,
  handledEventIds: new Set(),
  timeoutAt: "2026-01-02T00:00:00.000Z",
  reached: new Set(),
  correlationId: "c",
  parked: [],
  failure: { eventId: "e-1", letterId: "letter-1" },
  ...overrides,
});

let telemetry: FakeTelemetry | null = null;

afterEach(() => {
  telemetry?.restore();
  telemetry = null;
});

const setup = async () => {
  const recording = installFakeTelemetry();
  telemetry = recording;
  const storage = await memory().createStorage({ logger: silentLogger });
  const { logger, entries } = createRecordingLogger();
  const clock = createFixedClock(new Date("2026-03-04T05:06:07.000Z"));
  const failures = createProcessFailures({
    ids: createSequentialIdGenerator({ prefix: "letter" }),
    clock,
    logger,
  });
  const original = storage.deadLetterStore.add.bind(storage.deadLetterStore);
  let adds = 0;
  let failing = false;
  storage.deadLetterStore.add = async (added) => {
    adds += 1;
    if (failing) throw new Error("store down");
    return original(added);
  };
  return {
    storage,
    entries,
    clock,
    failures,
    telemetry: recording,
    adds: () => adds,
    failFiling: () => {
      failing = true;
    },
  };
};

describe("letterOf", () => {
  it("describes the failure of a process on its subject at the current time", async () => {
    const { failures } = await setup();
    expect(
      failures.letterOf(
        orderPayment,
        subject,
        new Error("payment refused"),
        3,
        "retriable_exhausted",
      ),
    ).toEqual({
      id: "letter-1",
      kind: "process",
      subscriber: "orderPayment",
      eventId: "e-1",
      eventType: "OrderPlaced",
      aggregateType: "order",
      aggregateId: "o-1",
      errorType: "retriable_exhausted",
      errorMessage: "payment refused",
      attempts: 3,
      firstFailedAt: "2026-03-04T05:06:07.000Z",
      lastFailedAt: "2026-03-04T05:06:07.000Z",
    });
  });

  it("gives every letter its own id and records what was thrown when it is no error", async () => {
    const { failures, clock } = await setup();
    failures.letterOf(orderPayment, subject, "first", 1, "terminal");
    clock.advance(1_000);
    expect(failures.letterOf(orderPayment, subject, "second", 1, "terminal")).toMatchObject({
      id: "letter-2",
      errorMessage: "second",
      firstFailedAt: "2026-03-04T05:06:08.000Z",
      lastFailedAt: "2026-03-04T05:06:08.000Z",
    });
  });
});

describe("file", () => {
  it("stages the letter with the error's stack, counting and logging nothing yet", async () => {
    const { failures, storage, entries, telemetry } = await setup();
    const error = new Error("boom");
    await failures.file(storage.deadLetterStore, orderPayment, letter, error);
    expect(await storage.deadLetterStore.get("letter-1")).toEqual({
      ...letter,
      errorStack: error.stack,
      status: "failed",
    });
    expect(telemetry.counts).toEqual([]);
    expect(entries).toEqual([]);
  });

  it("stores no stack when there is no error or it carries none", async () => {
    const { failures, storage } = await setup();
    await failures.file(storage.deadLetterStore, orderPayment, letter);
    await failures.file(
      storage.deadLetterStore,
      orderPayment,
      { ...letter, id: "letter-2" },
      "not an error",
    );
    expect(await storage.deadLetterStore.get("letter-1")).not.toHaveProperty("errorStack");
    expect(await storage.deadLetterStore.get("letter-2")).not.toHaveProperty("errorStack");
  });

  it("fails when the letter cannot be stored", async () => {
    const { failures, storage, failFiling } = await setup();
    failFiling();
    await expect(
      failures.file(storage.deadLetterStore, orderPayment, letter, new Error("boom")),
    ).rejects.toThrow("store down");
  });
});

describe("filed", () => {
  it("counts the letter and warns, once its unit committed", async () => {
    const { failures, entries, telemetry } = await setup();
    failures.filed(orderPayment, letter);
    expect(telemetry.counts).toEqual([
      {
        metric: "bounda.dead_letters",
        value: 1,
        attributes: {
          "bounda.subscriber.kind": "process",
          "bounda.subscriber": "orderPayment",
          "bounda.outcome": "terminal",
        },
      },
    ]);
    expect(entries).toEqual([
      {
        level: "warn",
        message: "process dead-lettered",
        fields: { process: "orderPayment", eventId: "e-1", errorType: "terminal", attempts: 1 },
      },
    ]);
  });
});

describe("deadlineSubject", () => {
  it("stands a deadline in for the event on the process's own stream", () => {
    expect(deadlineSubject(orderPayment, "o-1", "paymentDeadline")).toEqual({
      id: "deadline:paymentDeadline",
      type: "bounda.ProcessDeadline",
      aggregateType: "process:OrderPayment",
      aggregateId: "o-1",
    });
  });
});

describe("blockedOn", () => {
  it("matches any failure when no letter is named", () => {
    expect(blockedOn(instance(), undefined)).toBe(true);
    expect(blockedOn(instance({ failure: null }), undefined)).toBe(true);
  });

  it("matches only the failure the named letter records", () => {
    expect(blockedOn(instance(), "letter-1")).toBe(true);
    expect(blockedOn(instance(), "letter-2")).toBe(false);
    expect(blockedOn(instance({ failure: { eventId: "e-1" } }), "letter-1")).toBe(false);
    expect(blockedOn(instance({ failure: null }), "letter-1")).toBe(false);
  });
});

describe("drainFailureType", () => {
  it("keeps terminal errors terminal", () => {
    expect(drainFailureType(new DomainError("refused"))).toBe("terminal");
    expect(drainFailureType(new ValidationError("invalid", []))).toBe("terminal");
  });

  it("files retriable errors as exhausted, since nothing retries them while draining", () => {
    expect(drainFailureType(new Error("timeout"))).toBe("retriable_exhausted");
    expect(drainFailureType("unknown")).toBe("retriable_exhausted");
  });
});
