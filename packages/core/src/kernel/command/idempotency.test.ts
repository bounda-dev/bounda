import { describe, expect, it, onTestFinished } from "vitest";
import {
  ConfigurationError,
  DomainError,
  IdempotencyKeyConflictError,
  IdempotencyKeyTakenError,
  ValidationError,
} from "../../contracts/errors.ts";
import { classifyFailure } from "../shared/retry.ts";
import { ATTRIBUTES } from "../telemetry.ts";
import { installFakeTelemetry } from "../telemetry-fake.ts";
import {
  createKernelHarness,
  createRecordingLogger,
  type KernelHarness,
  placeOrderKeys,
  sentMessages,
} from "../test-support.ts";
import { createUnitOfWork } from "../unit-of-work/unit-of-work.ts";
import { fingerprintOf } from "./fingerprint.ts";

const now = new Date("2026-01-01T00:00:00.000Z");
const placeOrder = { type: "PlaceOrder", payload: { orderId: "o-1", total: 42 } };
const withKey = (idempotencyKey: string, extra = {}) => ({
  options: { idempotencyKey, ...extra },
});

const storedTypes = async ({ storage }: KernelHarness): Promise<string[]> =>
  (await storage.eventStore.readAll({ afterPosition: 0, limit: 100 })).map((event) => event.type);

describe("a command dispatched with an idempotency key", () => {
  it("runs once and answers every later dispatch with the same key and payload the same, without running", async () => {
    const telemetry = installFakeTelemetry();
    onTestFinished(() => telemetry.restore());
    const harness = await createKernelHarness();
    const first = await harness.pipeline.dispatch({ ...placeOrder, ...withKey("req-1") });
    expect(first).toMatchObject({ scheduled: false, version: 1, position: 1 });
    harness.clock.advance(1_000);
    const again = await harness.pipeline.dispatch({
      type: "PlaceOrder",
      // The same payload written in another order.
      payload: { total: 42, orderId: "o-1" },
      ...withKey("req-1"),
    });
    expect(again).toEqual(first);
    expect(sentMessages).toEqual(["placed o-1 v0"]);
    expect(await storedTypes(harness)).toEqual(["OrderPlaced"]);
    expect(await harness.storage.idempotencyStore.get({ key: "req-1", now })).toMatchObject({
      outcome: first,
      expiresAt: "2026-01-02T00:00:00.000Z",
      persons: [],
    });
    expect(telemetry.counts.map((count) => count.attributes[ATTRIBUTES.outcome])).toEqual([
      "stored",
      "replayed",
    ]);
    expect(telemetry.spans.at(-1)?.attributes[ATTRIBUTES.outcome]).toBe("replayed");
  });

  it("remembers a rejection as well, and throws it again with its code and message", async () => {
    const telemetry = installFakeTelemetry();
    onTestFinished(() => telemetry.restore());
    const harness = await createKernelHarness();
    await harness.pipeline.dispatch(placeOrder);
    const rejection = () =>
      harness.pipeline.dispatch({ ...placeOrder, ...withKey("req-2") }).catch((e: unknown) => e);
    const first = await rejection();
    expect(first).toBeInstanceOf(DomainError);
    expect(placeOrderKeys).toHaveLength(2);
    const again = await rejection();
    expect(again).toBeInstanceOf(DomainError);
    expect(again).toMatchObject({ rejected: "AlreadyPlaced", message: "Order already placed" });
    expect(again).not.toBe(first);
    expect(placeOrderKeys).toHaveLength(2);
    expect(await storedTypes(harness)).toEqual(["OrderPlaced"]);
    expect(telemetry.spans.at(-1)?.attributes[ATTRIBUTES.outcome]).toBe("replayed");
    expect(telemetry.spanEvents.map((event) => event.attributes)).toEqual([
      { [ATTRIBUTES.rejected]: "AlreadyPlaced" },
      { [ATTRIBUTES.rejected]: "AlreadyPlaced" },
    ]);
  });

  it("remembers a command that stored nothing", async () => {
    const harness = await createKernelHarness();
    const touch = { type: "TouchOrder", payload: { orderId: "o-1" }, ...withKey("req-3") };
    const first = await harness.pipeline.dispatch(touch);
    expect(first).toMatchObject({ scheduled: false, version: 0, eventIds: [], position: 0 });
    expect(await harness.pipeline.dispatch(touch)).toEqual(first);
    expect(await harness.storage.idempotencyStore.get({ key: "req-3", now })).not.toBeNull();
  });

  it("refuses the same key for another command or another payload, and runs nothing", async () => {
    const harness = await createKernelHarness();
    await harness.pipeline.dispatch({ ...placeOrder, ...withKey("req-1") });
    const otherPayload = await harness.pipeline
      .dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 43 }, ...withKey("req-1") })
      .catch((error: unknown) => error);
    expect(otherPayload).toBeInstanceOf(IdempotencyKeyConflictError);
    expect(otherPayload).toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
      idempotencyKey: "req-1",
    });
    expect((otherPayload as Error).message).toContain('"req-1"');
    expect((otherPayload as Error).message).toContain("PlaceOrder");
    await expect(
      harness.pipeline.dispatch({
        type: "TouchOrder",
        payload: { orderId: "o-1" },
        ...withKey("req-1"),
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(classifyFailure(otherPayload)).toBe("terminal");
    expect(placeOrderKeys).toHaveLength(1);
    expect(await storedTypes(harness)).toEqual(["OrderPlaced"]);
  });

  it("gives two dispatches racing for one key the same answer, storing the events once", async () => {
    const harness = await createKernelHarness();
    const results = await Promise.all([
      harness.pipeline.dispatch({ ...placeOrder, ...withKey("req-1") }),
      harness.pipeline.dispatch({ ...placeOrder, ...withKey("req-1") }),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ version: 1, position: 1 });
    expect(await storedTypes(harness)).toEqual(["OrderPlaced"]);
  });

  it("records what a retry after a conflict answers, not what the lost attempt did", async () => {
    const harness = await createKernelHarness();
    const transact = harness.storage.transact.bind(harness.storage);
    let interfered = false;
    harness.storage.transact = async (work) => {
      if (!interfered) {
        interfered = true;
        await harness.pipeline.dispatch(placeOrder);
      }
      return transact(work);
    };
    const first = await harness.pipeline
      .dispatch({ ...placeOrder, ...withKey("req-1") })
      .catch((error: unknown) => error);
    expect(first).toMatchObject({ rejected: "AlreadyPlaced" });
    expect(placeOrderKeys).toEqual(["id-1", "id-3", "id-1"]);
    await expect(
      harness.pipeline.dispatch({ ...placeOrder, ...withKey("req-1") }),
    ).rejects.toMatchObject({ rejected: "AlreadyPlaced" });
    expect(placeOrderKeys).toHaveLength(3);
    expect(await storedTypes(harness)).toEqual(["OrderPlaced"]);
  });

  it("answers what the key holds when it loses the race to record, and fails when the record has gone", async () => {
    const telemetry = installFakeTelemetry();
    onTestFinished(() => telemetry.restore());
    const harness = await createKernelHarness();
    const { idempotencyStore } = harness.storage;
    const winner = {
      key: "req-1",
      fingerprint: await fingerprintOf(placeOrder),
      outcome: {
        scheduled: false as const,
        aggregateType: "order",
        aggregateId: "o-1",
        version: 7,
        eventIds: ["elsewhere"],
        eventTypes: ["OrderPlaced"],
        position: 7,
      },
      expiresAt: "2026-01-02T00:00:00.000Z",
      persons: [],
      now,
    };
    // The winner records once this dispatch has looked the key up and found nothing.
    const get = idempotencyStore.get;
    let looked = 0;
    harness.storage.idempotencyStore.get = async (args) => {
      looked += 1;
      const found = await get(args);
      if (looked === 1) await idempotencyStore.put(winner);
      return found;
    };
    expect(await harness.pipeline.dispatch({ ...placeOrder, ...withKey("req-1") })).toEqual(
      winner.outcome,
    );
    expect(placeOrderKeys).toHaveLength(1);
    expect(await storedTypes(harness)).toEqual([]);
    expect(telemetry.counts.map((count) => count.attributes[ATTRIBUTES.outcome])).toEqual([
      "replayed",
    ]);

    harness.storage.idempotencyStore.get = async () => null;
    const lost = await harness.pipeline
      .dispatch({ ...placeOrder, ...withKey("req-1") })
      .catch((error: unknown) => error);
    expect(lost).toBeInstanceOf(IdempotencyKeyTakenError);
    expect(telemetry.counts.at(-1)?.attributes[ATTRIBUTES.outcome]).toBe("failed");
    expect(await storedTypes(harness)).toEqual([]);

    // Any other failure stays a failure, whatever the key holds by then.
    const broken = { type: "BreakOrder", payload: { orderId: "o-1" } };
    looked = 0;
    harness.storage.idempotencyStore.get = async () => {
      looked += 1;
      return looked === 1 ? null : { ...winner, fingerprint: await fingerprintOf(broken) };
    };
    await expect(
      harness.pipeline.dispatch({ ...broken, ...withKey("req-2") }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("schedules a delayed command once under its key", async () => {
    const harness = await createKernelHarness();
    const delayed = { ...placeOrder, ...withKey("req-1", { delay: "5m" }) };
    const first = await harness.pipeline.dispatch(delayed);
    expect(first).toMatchObject({ scheduled: true, executeAt: "2026-01-01T00:05:00.000Z" });
    harness.clock.advance(1_000);
    expect(await harness.pipeline.dispatch(delayed)).toEqual(first);
    expect(await harness.storage.scheduler.list()).toHaveLength(1);
  });

  it("refuses the key of a delayed command for the same command now, or with another delay", async () => {
    const harness = await createKernelHarness();
    await harness.pipeline.dispatch({ ...placeOrder, ...withKey("req-1", { delay: "5m" }) });
    await expect(
      harness.pipeline.dispatch({ ...placeOrder, ...withKey("req-1") }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(
      harness.pipeline.dispatch({ ...placeOrder, ...withKey("req-1", { delay: "10m" }) }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(
      await harness.pipeline.dispatch({ ...placeOrder, ...withKey("req-1", { delay: 300_000 }) }),
    ).toMatchObject({ scheduled: true });
    expect(await storedTypes(harness)).toEqual([]);
  });

  it("forgets a key once its lifetime has passed, and runs the command again", async () => {
    const harness = await createKernelHarness({
      config: { runtime: { commands: { idempotencyKeyLifetime: "1h" } } },
    });
    const touch = { type: "TouchOrder", payload: { orderId: "o-1" }, ...withKey("req-1") };
    await harness.pipeline.dispatch(touch);
    expect(await harness.storage.idempotencyStore.get({ key: "req-1", now })).toMatchObject({
      expiresAt: "2026-01-01T01:00:00.000Z",
      persons: [],
    });
    harness.clock.advance(3_600_000);
    await harness.pipeline.dispatch({ ...placeOrder, ...withKey("req-1") });
    expect(await storedTypes(harness)).toEqual(["OrderPlaced"]);
    expect(
      await harness.storage.idempotencyStore.get({ key: "req-1", now: harness.clock.now() }),
    ).toMatchObject({ outcome: { eventTypes: ["OrderPlaced"] } });
  });

  it("does not remember a command that failed, so a retry runs it", async () => {
    const harness = await createKernelHarness();
    const broken = { type: "BreakOrder", payload: { orderId: "o-1" }, ...withKey("req-1") };
    await expect(harness.pipeline.dispatch(broken)).rejects.toBeInstanceOf(ConfigurationError);
    expect(await harness.storage.idempotencyStore.get({ key: "req-1", now })).toBeNull();
    await expect(harness.pipeline.dispatch(broken)).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("refuses an empty key, or one too long, before running anything", async () => {
    const harness = await createKernelHarness();
    for (const idempotencyKey of ["", "k".repeat(256), 7, ["k"]] as unknown as string[]) {
      const refused = await harness.pipeline
        .dispatch({ ...placeOrder, options: { idempotencyKey } })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ValidationError);
      expect(refused).toMatchObject({
        message: 'Command "PlaceOrder" has an invalid idempotency key',
        issues: [{ path: ["idempotencyKey"], message: "Expected a string of 1 to 255 characters" }],
      });
    }
    expect(placeOrderKeys).toEqual([]);
    await harness.pipeline.dispatch({ ...placeOrder, ...withKey("k".repeat(255)) });
    expect(placeOrderKeys).toHaveLength(1);
  });

  it("records a dispatch within a unit of work when the unit commits, and answers the next from it", async () => {
    const { logger, entries } = createRecordingLogger();
    const harness = await createKernelHarness({ logger });
    const unit = createUnitOfWork({ storage: harness.storage });
    const first = await harness.pipeline.dispatchUnattended({
      ...placeOrder,
      ...withKey("req-1"),
      within: unit,
    });
    expect(first).toMatchObject({ scheduled: false, version: 1, position: 0 });
    expect(await harness.storage.idempotencyStore.get({ key: "req-1", now })).toBeNull();
    await unit.commit();
    expect(await harness.storage.idempotencyStore.get({ key: "req-1", now })).toMatchObject({
      outcome: first,
    });
    expect(await storedTypes(harness)).toEqual(["OrderPlaced"]);

    const again = createUnitOfWork({ storage: harness.storage });
    expect(
      await harness.pipeline.dispatchUnattended({
        ...placeOrder,
        ...withKey("req-1"),
        within: again,
      }),
    ).toEqual(first);
    expect(placeOrderKeys).toHaveLength(1);

    const rejecting = createUnitOfWork({ storage: harness.storage });
    const rejected = await harness.pipeline.dispatchUnattended({
      ...placeOrder,
      ...withKey("req-2"),
      within: rejecting,
    });
    expect(rejected).toMatchObject({ rejected: "AlreadyPlaced" });
    await rejecting.commit();
    const replayed = await harness.pipeline.dispatchUnattended({
      ...placeOrder,
      ...withKey("req-2"),
      within: createUnitOfWork({ storage: harness.storage }),
    });
    expect(replayed).toEqual(rejected);
    expect(placeOrderKeys).toHaveLength(2);
    expect(entries.filter((entry) => entry.message === "command rejected")).toHaveLength(2);
    expect(harness.rejections).toHaveLength(1);

    const twice = createUnitOfWork({ storage: harness.storage });
    const once = await harness.pipeline.dispatchUnattended({
      type: "TouchOrder",
      payload: { orderId: "o-9" },
      ...withKey("req-9"),
      within: twice,
    });
    expect(
      await harness.pipeline.dispatchUnattended({
        type: "TouchOrder",
        payload: { orderId: "o-9" },
        ...withKey("req-9"),
        within: twice,
      }),
    ).toEqual(once);
    await twice.commit();
    expect(await harness.storage.idempotencyStore.get({ key: "req-9", now })).toMatchObject({
      outcome: once,
    });

    const scheduling = createUnitOfWork({ storage: harness.storage });
    const delayed = await harness.pipeline.dispatchUnattended({
      ...placeOrder,
      ...withKey("req-3", { delay: "5m" }),
      within: scheduling,
    });
    expect(delayed).toMatchObject({ scheduled: true });
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect(await harness.storage.idempotencyStore.get({ key: "req-3", now })).toBeNull();
    await scheduling.commit();
    expect(await harness.storage.scheduler.list()).toHaveLength(1);
    expect(await harness.storage.idempotencyStore.get({ key: "req-3", now })).toMatchObject({
      outcome: delayed,
    });
  });
});
