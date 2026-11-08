import { afterEach, describe, expect, it } from "vitest";
import type { NewDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { memory } from "../../memory/index.ts";
import type { EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { isSealed } from "../personal-data/crypto.ts";
import { type FakeTelemetry, installFakeTelemetry } from "../telemetry-fake.ts";
import { createRecordingLogger, keysOver, newStoredKey } from "../test-support.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { TIMEOUT_DEADLINE } from "./deadlines.ts";
import { blockedOn, createProcessFailures, deadlineSubject, drainFailureType } from "./failures.ts";
import type { ProcessInstance } from "./lifecycle.ts";

const orderPayment: ProcessRuntime = {
  name: "orderPayment",
  aggregate: "order",
  startedBy: new Set(["OrderPlaced"]),
  completedBy: new Set(["OrderPaid"]),
  lifetimeMs: 60_000,
  handlerTimeoutMs: 30_000,
  initialState: {},
  stateSchema: null,
  personal: null,
  handlers: {},
  deadlineFields: [],
  deadlineHandlers: {},
  ports: {},
  instanceOf: (event) => event.aggregateId,
};

const registry: Registry = {
  aggregates: {
    order: {
      events: {
        orderPlaced: {
          payload: ({ z, personal, person }: EventPayloadArgs) =>
            z.object({ customerId: person(z.string()), note: personal(z.string()).optional() }),
          evolve: () => ({}),
        },
      },
      commands: {},
      policies: {},
      processes: {},
    },
  },
  readModels: {},
};

const aggregates = buildAggregates({ registry, ports: {} });

const subject = {
  id: "e-1",
  type: "OrderPlaced",
  aggregateType: "order",
  aggregateId: "o-1",
  person: null,
  read: [],
};

const placed = (payload: unknown) => ({
  ...pendingEvent({ aggregateId: "o-1", version: 1, id: "e-1", payload }),
  position: 1,
});

const letter: NewDeadLetter = {
  id: "letter-1",
  kind: "process",
  handler: "orderPayment",
  eventId: "e-1",
  eventType: "OrderPlaced",
  aggregateType: "order",
  aggregateId: "o-1",
  errorType: "terminal",
  person: null,
  errorName: "Error",
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
  deadlineCauses: new Map(),
  correlationId: "c",
  parked: [],
  followUps: new Set(),
  failure: { eventId: "e-1", letterId: "letter-1" },
  persons: [],
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
  const storage = await memory().createStorage();
  const { logger, entries } = createRecordingLogger("omit");
  const clock = createFixedClock(new Date("2026-03-04T05:06:07.000Z"));
  const failures = createProcessFailures({
    aggregates,
    keys: keysOver(storage.personalKeys),
    ids: createSequentialIdGenerator({ prefix: "letter" }),
    clock,
    logger,
  });
  return { storage, entries, clock, failures, telemetry: recording };
};

describe("subjectOf", () => {
  it("names the person the event names, and nobody for an event without their data", async () => {
    const { failures } = await setup();
    expect(
      failures.subjectOf(orderPayment, placed({ customerId: "c-1", note: "ring" }), null),
    ).toEqual({
      ...subject,
      person: "c-1",
    });
    expect(
      failures.subjectOf(orderPayment, placed({ customerId: "c-1", note: null }), null),
    ).toEqual(subject);
    expect(failures.subjectOf(orderPayment, placed({ customerId: "c-1" }), null)).toEqual(subject);
    expect(
      failures.subjectOf(
        orderPayment,
        { ...placed({ customerId: "c-1", note: "ring" }), aggregateType: "x" },
        null,
      ),
    ).toEqual({ ...subject, aggregateType: "x" });
  });
});

describe("letterOf", () => {
  it("describes the failure of a process on its subject at the current time, with the error's stack", async () => {
    const { failures, telemetry, entries } = await setup();
    const error = new Error("payment refused");
    expect(await failures.letterOf(orderPayment, subject, error, 3, "retriable_exhausted")).toEqual(
      {
        id: "letter-1",
        kind: "process",
        handler: "orderPayment",
        eventId: "e-1",
        eventType: "OrderPlaced",
        aggregateType: "order",
        aggregateId: "o-1",
        person: null,
        errorType: "retriable_exhausted",
        errorName: "Error",
        errorMessage: "payment refused",
        errorStack: error.stack,
        attempts: 3,
        firstFailedAt: "2026-03-04T05:06:07.000Z",
        lastFailedAt: "2026-03-04T05:06:07.000Z",
      },
    );
    expect(telemetry.counts).toEqual([]);
    expect(entries).toEqual([]);
  });

  it("gives every letter its own id and records what was thrown when it is no error, without a stack", async () => {
    const { failures, clock } = await setup();
    await failures.letterOf(orderPayment, subject, "first", 1, "terminal");
    clock.advance(1_000);
    const second = await failures.letterOf(orderPayment, subject, "second", 1, "terminal");
    expect(second).toMatchObject({
      id: "letter-2",
      errorName: "string",
      errorMessage: "second",
      firstFailedAt: "2026-03-04T05:06:08.000Z",
      lastFailedAt: "2026-03-04T05:06:08.000Z",
    });
    expect(second).not.toHaveProperty("errorCode");
    expect(second).not.toHaveProperty("errorStack");
  });

  it("names a BoundaError's code", async () => {
    const { failures } = await setup();
    expect(
      await failures.letterOf(orderPayment, subject, new ValidationError("no", []), 1, "terminal"),
    ).toMatchObject({ errorName: "ValidationError", errorCode: "VALIDATION_FAILED" });
  });

  it("seals the message and the stack under the key the subject's person holds", async () => {
    const { failures, storage } = await setup();
    await storage.personalKeys.add("c-1", await newStoredKey());
    const error = new Error("cannot mail ana@example.com");
    const letter = await failures.letterOf(
      orderPayment,
      { ...subject, person: "c-1" },
      error,
      1,
      "terminal",
    );
    expect(letter).toMatchObject({ person: "c-1", errorName: "Error" });
    expect(isSealed(letter.errorMessage)).toBe(true);
    expect(isSealed(letter.errorStack)).toBe(true);
    expect(JSON.stringify(letter)).not.toContain("ana@example.com");
    const key = await storage.personalKeys.get("c-1");
    expect(key).not.toBeNull();
    expect(letter.errorMessage).toMatchObject({
      $personal: { person: "c-1", key: key?.fingerprint },
    });
  });

  it("seals the text unreadable when the person no longer holds the key the subject was read under", async () => {
    const { failures, storage } = await setup();
    const read = await newStoredKey();
    await storage.personalKeys.add("c-1", await newStoredKey());
    const letter = await failures.letterOf(
      orderPayment,
      { ...subject, person: "c-1", read: [{ person: "c-1", fingerprint: read.fingerprint }] },
      new Error("cannot mail ana@example.com"),
      1,
      "terminal",
    );
    expect(isSealed(letter.errorMessage)).toBe(true);
    expect(letter.errorMessage).not.toMatchObject({
      $personal: { key: (await storage.personalKeys.get("c-1"))?.fingerprint },
    });
    expect(letter.errorMessage).not.toMatchObject({ $personal: { key: read.fingerprint } });
  });

  it("gives no key to a person who holds none, sealing the text unreadable", async () => {
    const { failures, storage } = await setup();
    const letter = await failures.letterOf(
      orderPayment,
      { ...subject, person: "c-1" },
      new Error("cannot mail ana@example.com"),
      1,
      "terminal",
    );
    expect(isSealed(letter.errorMessage)).toBe(true);
    expect(await storage.personalKeys.get("c-1")).toBeNull();
  });
});

describe("filed", () => {
  it("counts the letter and warns, once its unit committed", async () => {
    const { failures, entries, telemetry } = await setup();
    failures.filed(orderPayment, letter, new Error("mailer down"));
    expect(telemetry.counts).toEqual([
      {
        metric: "bounda.dead_letters",
        value: 1,
        attributes: {
          "bounda.handler.kind": "process",
          "bounda.handler": "orderPayment",
          "bounda.outcome": "terminal",
        },
      },
    ]);
    expect(entries).toEqual([
      {
        level: "warn",
        message: "process dead-lettered",
        fields: {
          process: "orderPayment",
          eventId: "e-1",
          letterId: "letter-1",
          errorName: "Error",
          errorType: "terminal",
          attempts: 1,
        },
      },
    ]);
  });
});

describe("subjectOf an event on a loaded instance", () => {
  const onboarding: ProcessRuntime = {
    ...orderPayment,
    personal: { person: "customerId", fields: ["email"] },
  };
  const held = { person: "c-2", fingerprint: "f-2" };
  const loaded = instance({ state: { customerId: "c-2", email: "a@b.c" }, persons: [held] });

  it("names whom the state names when the event names nobody, with what the instance opened", async () => {
    const { failures } = await setup();
    expect(
      failures.subjectOf(onboarding, placed({ customerId: "c-1" }), {
        instanceId: "o-1",
        instance: loaded,
      }),
    ).toEqual({
      ...subject,
      person: "c-2",
      read: [held],
    });
    expect(
      failures.subjectOf(onboarding, placed({ customerId: "c-1", note: "ring" }), {
        instanceId: "o-1",
        instance: loaded,
      }),
    ).toEqual({ ...subject, person: "c-1", read: [held] });
    expect(
      failures.subjectOf(orderPayment, placed({ customerId: "c-1" }), {
        instanceId: "o-1",
        instance: loaded,
      }),
    ).toEqual({
      ...subject,
      read: [held],
    });
  });

  it("stands a deadline in under whom the state names", () => {
    expect(deadlineSubject(onboarding, "o-1", "paymentDeadline", loaded)).toMatchObject({
      person: "c-2",
      read: [held],
    });
  });
});

describe("deadlineSubject", () => {
  it("stands a deadline in for the event on the process's own stream", () => {
    expect(
      deadlineSubject(orderPayment, "o-1", "paymentDeadline", { state: {}, persons: [] }),
    ).toEqual({
      id: "deadline:paymentDeadline",
      type: "bounda.ProcessDeadline",
      aggregateType: "process:orderPayment",
      aggregateId: "o-1",
      person: null,
      read: [],
    });
  });

  it("names the timeout's letter deadline:timeout, which bounda dead-letters list relies on", () => {
    expect(
      deadlineSubject(orderPayment, "o-1", TIMEOUT_DEADLINE, { state: {}, persons: [] }).id,
    ).toBe("deadline:timeout");
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
    expect(drainFailureType(new ValidationError("refused", []))).toBe("terminal");
    expect(drainFailureType(new ValidationError("invalid", []))).toBe("terminal");
  });

  it("files retriable errors as exhausted, since nothing retries them while draining", () => {
    expect(drainFailureType(new Error("timeout"))).toBe("retriable_exhausted");
    expect(drainFailureType("unknown")).toBe("retriable_exhausted");
  });
});
