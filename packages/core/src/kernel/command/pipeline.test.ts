import { describe, expect, it, onTestFinished } from "vitest";
import {
  BoundaError,
  ChainDepthExceededError,
  ConcurrencyError,
  ConfigurationError,
  CreationOrderError,
  DomainError,
  NotFoundError,
  rejectionOf,
  ValidationError,
} from "../../contracts/errors.ts";
import type { RejectFunction } from "../../modules/command.ts";
import type { Registry } from "../../modules/registry.ts";
import { classifyFailure } from "../shared/retry.ts";
import { HandlerTimeoutError } from "../shared/timeout.ts";
import { ATTRIBUTES } from "../telemetry.ts";
import { installFakeTelemetry } from "../telemetry-fake.ts";
import {
  createKernelHarness,
  createRecordingLogger,
  drained,
  type KernelHarness,
  orderRegistry,
  placeOrderKeys,
  sentMessages,
  slowJob,
  withJob,
} from "../test-support.ts";
import { createUnitOfWork } from "../unit-of-work/unit-of-work.ts";

const withTickets: Registry = {
  aggregates: {
    ...orderRegistry.aggregates,
    ticket: {
      events: {
        ticketOpened: { evolve: ({ state }: { state: object }) => state },
        ticketTagged: { evolve: ({ state }: { state: object }) => state },
      },
      commands: {
        openTicket: {
          module: {
            handler: ({ events }: { events: Record<string, (payload?: unknown) => unknown> }) => [
              events.ticketOpened?.(),
              events.ticketTagged?.(),
            ],
          },
        },
        touchTicket: { module: { handler: () => undefined } },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
};

describe("command pipeline", () => {
  it("validates, runs the handler with ports and appends with the loaded version", async () => {
    const { pipeline, storage } = await createKernelHarness();
    const result = await pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 42 },
    });
    expect(result).toEqual({
      scheduled: false,
      aggregateType: "order",
      aggregateId: "o-1",
      version: 1,
      eventIds: ["id-2"],
      eventTypes: ["OrderPlaced"],
      position: 1,
    });
    expect(sentMessages).toEqual(["placed o-1 v0"]);

    const loaded = await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.events[0]).toEqual({
      id: "id-2",
      aggregateType: "order",
      aggregateId: "o-1",
      version: 1,
      position: 1,
      type: "OrderPlaced",
      payload: { total: 42 },
      timestamp: "2026-01-01T00:00:00.000Z",
      metadata: {
        correlationId: "id-1",
        causationId: "id-1",
        depth: 0,
        schemaVersion: 1,
        system: false,
      },
    });
  });

  it("folds the stream into state before the next command", async () => {
    const { pipeline } = await createKernelHarness();
    await pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 42 } });
    const paid = await pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    expect(paid).toMatchObject({ version: 2, eventIds: ["id-4"] });
    await expect(
      pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 1 } }),
    ).rejects.toMatchObject({ rejected: "AlreadyPlaced" });
  });

  it("throws a rejection as the handler made it, with the message rejections gives, and persists nothing", async () => {
    const { pipeline, storage } = await createKernelHarness();
    const rejection = pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await expect(rejection).rejects.toBeInstanceOf(DomainError);
    await expect(rejection).rejects.toMatchObject({
      rejected: "NotPlaced",
      message: "Only placed orders can be paid; this one is new",
      stack: expect.stringContaining("test-support.ts"),
    });
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("resolves with the rejection of a dispatch within a unit of work, and reports it once the unit commits", async () => {
    const { logger, entries } = createRecordingLogger();
    const { pipeline, storage, rejections } = await createKernelHarness({ logger });
    await expect(
      pipeline.dispatch({ type: "PayOrder", payload: { orderId: "o-1", method: "card" } }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(entries.filter((entry) => entry.message === "command rejected")).toEqual([]);

    const unit = createUnitOfWork({ storage });
    expect(
      await pipeline.dispatchUnattended({
        type: "PayOrder",
        payload: { orderId: "o-1", method: "card" },
        within: unit,
      }),
    ).toEqual({
      rejected: "NotPlaced",
      message: "Only placed orders can be paid; this one is new",
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(entries.filter((entry) => entry.message === "command rejected")).toMatchObject([
      { level: "info", fields: { type: "PayOrder", rejected: "NotPlaced" } },
    ]);
    expect(rejections).toEqual([]);
    await unit.commit();
    expect(rejections).toEqual([
      {
        type: "PayOrder",
        rejected: "NotPlaced",
        message: "Only placed orders can be paid; this one is new",
        aggregateType: "order",
        aggregateId: "o-1",
      },
    ]);
  });

  it("never reports the rejection of a unit of work that does not commit", async () => {
    const { pipeline, storage, rejections } = await createKernelHarness();
    await pipeline.dispatchUnattended({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
      within: createUnitOfWork({ storage }),
    });
    expect(rejections).toEqual([]);
  });

  it("fails, rather than rejects, a command whose handler throws or returns a DomainError it did not make", async () => {
    const foreign = new DomainError(rejectionOf("Elsewhere", "Another app said no"));
    const order = orderRegistry.aggregates.order as Registry["aggregates"][string];
    const { pipeline, storage } = await createKernelHarness({
      registry: {
        aggregates: {
          order: {
            ...order,
            commands: {
              ...order.commands,
              noteOrder: {
                module: {
                  payload: ({ z }) => z.object({ orderId: z.string() }),
                  rejections: () => ({ Closed: "Notes are closed" }),
                  handler: () => {
                    throw foreign;
                  },
                },
              },
              tagOrder: {
                module: {
                  payload: ({ z }) => z.object({ orderId: z.string() }),
                  rejections: () => ({ Closed: "Tags are closed" }),
                  handler: () => foreign,
                },
              },
            },
          },
        },
        readModels: {},
      },
    });

    const failed = (command: string) => ({
      code: "FOREIGN_REJECTION",
      message: `Command ${command} failed on rejection Elsewhere, which its handler did not make with reject: Another app said no`,
      cause: foreign,
    });
    const thrown = await pipeline
      .dispatch({ type: "NoteOrder", payload: { orderId: "o-1" } })
      .catch((error: unknown) => error);
    expect(thrown).not.toBeInstanceOf(DomainError);
    expect(thrown).toBeInstanceOf(BoundaError);
    expect(thrown).toMatchObject(failed("NoteOrder"));
    expect(classifyFailure(thrown)).toBe("terminal");
    await expect(
      pipeline.dispatchUnattended({
        type: "TagOrder",
        payload: { orderId: "o-1" },
        within: createUnitOfWork({ storage }),
      }),
    ).rejects.toMatchObject(failed("TagOrder"));
  });

  it("gives reject only to a command that declares rejections, and takes the message it is passed", async () => {
    const given: boolean[] = [];
    const order = orderRegistry.aggregates.order as Registry["aggregates"][string];
    const { pipeline } = await createKernelHarness({
      registry: {
        aggregates: {
          order: {
            ...order,
            commands: {
              ...order.commands,
              closeOrder: {
                module: {
                  payload: ({ z }) => z.object({ orderId: z.string() }),
                  rejections: () => ({ NotOpen: "Only open orders can be closed" }),
                  handler: (args: { readonly reject: RejectFunction<"NotOpen"> }) => {
                    given.push("reject" in args);
                    return args.reject("NotOpen", "Closed twice");
                  },
                },
              },
              noteOrder: {
                module: {
                  payload: ({ z }) => z.object({ orderId: z.string() }),
                  handler: (args: object) => {
                    given.push("reject" in args);
                    return [];
                  },
                },
              },
            },
          },
        },
        readModels: {},
      },
    });

    await expect(
      pipeline.dispatch({ type: "CloseOrder", payload: { orderId: "o-1" } }),
    ).rejects.toMatchObject({ rejected: "NotOpen", message: "Closed twice" });
    await pipeline.dispatch({ type: "NoteOrder", payload: { orderId: "o-1" } });
    expect(given).toEqual([true, false]);
  });

  it("keeps a rejection whose rejections throw or leave its code out, with the code as message and a warning", async () => {
    const { logger, entries } = createRecordingLogger();
    const order = orderRegistry.aggregates.order as Registry["aggregates"][string];
    const { pipeline } = await createKernelHarness({
      logger,
      registry: {
        aggregates: {
          order: {
            ...order,
            commands: {
              ...order.commands,
              closeOrder: {
                module: {
                  payload: ({ z }) => z.object({ orderId: z.string() }),
                  rejections: (): Record<string, string> => {
                    throw new TypeError("no items");
                  },
                  handler: ({ reject }: { readonly reject: RejectFunction<"NotOpen"> }) =>
                    reject("NotOpen"),
                },
              },
              noteOrder: {
                module: {
                  payload: ({ z }) => z.object({ orderId: z.string() }),
                  rejections: () => ({ Closed: "Notes are closed" }),
                  handler: ({ reject }: { readonly reject: RejectFunction<string> }) =>
                    reject("toString"),
                },
              },
              tagOrder: {
                module: {
                  payload: ({ z }) => z.object({ orderId: z.string() }),
                  rejections: () => undefined as unknown as Record<string, string>,
                  handler: ({ reject }: { readonly reject: RejectFunction<"Closed"> }) =>
                    reject("Closed"),
                },
              },
            },
          },
        },
        readModels: {},
      },
    });

    await expect(
      pipeline.dispatch({ type: "CloseOrder", payload: { orderId: "o-1" } }),
    ).rejects.toMatchObject({ rejected: "NotOpen", message: "NotOpen" });
    await expect(
      pipeline.dispatch({ type: "NoteOrder", payload: { orderId: "o-1" } }),
    ).rejects.toMatchObject({ rejected: "toString", message: "toString" });
    await expect(
      pipeline.dispatch({ type: "TagOrder", payload: { orderId: "o-1" } }),
    ).rejects.toMatchObject({ rejected: "Closed", message: "Closed" });
    expect(entries.filter((entry) => entry.level === "warn")).toEqual([
      {
        level: "warn",
        message: "command rejections threw; the rejection takes its code as message",
        fields: {
          type: "CloseOrder",
          rejected: "NotOpen",
          error: { message: "no items", stack: expect.any(String) },
        },
      },
      {
        level: "warn",
        message:
          "command rejected with a code its rejections do not declare; the code is its message",
        fields: { type: "NoteOrder", rejected: "toString" },
      },
      {
        level: "warn",
        message:
          "command rejected with a code its rejections do not declare; the code is its message",
        fields: { type: "TagOrder", rejected: "Closed" },
      },
    ]);
  });

  it("rejects an invalid payload with issues and never runs the handler", async () => {
    const { pipeline } = await createKernelHarness();
    let error: unknown;
    try {
      await pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: "lots" } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues).toEqual([
      { path: ["total"], message: expect.stringContaining("number") },
    ]);
    expect(sentMessages).toEqual([]);
  });

  it("requires the aggregate id field", async () => {
    const { pipeline } = await createKernelHarness();
    await expect(
      pipeline.dispatch({ type: "TouchOrder", payload: { orderId: "" } }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      issues: [{ path: ["orderId"], message: "Expected a non-empty string" }],
    });
  });

  it("rejects unknown commands", async () => {
    const { pipeline } = await createKernelHarness();
    await expect(pipeline.dispatch({ type: "ShipOrder", payload: {} })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("appends nothing when the handler returns no events", async () => {
    const { pipeline, storage } = await createKernelHarness();
    const result = await pipeline.dispatch({ type: "TouchOrder", payload: { orderId: "o-1" } });
    expect(result).toEqual({
      scheduled: false,
      aggregateType: "order",
      aggregateId: "o-1",
      version: 0,
      eventIds: [],
      eventTypes: [],
      position: 0,
    });
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("numbers the events of one command consecutively after the loaded version", async () => {
    const { pipeline, storage } = await createKernelHarness({ registry: withTickets });
    const result = await pipeline.dispatch({ type: "OpenTicket", payload: { ticketId: "t-1" } });
    expect(result).toMatchObject({
      version: 2,
      eventIds: ["id-2", "id-3"],
      eventTypes: ["TicketOpened", "TicketTagged"],
      position: 2,
    });
    const loaded = await storage.eventStore.load({ aggregateType: "ticket", aggregateId: "t-1" });
    expect(loaded.events.map((event) => [event.type, event.version])).toEqual([
      ["TicketOpened", 1],
      ["TicketTagged", 2],
    ]);
  });

  it("requires a string aggregate id even without a payload schema", async () => {
    const { pipeline } = await createKernelHarness({ registry: withTickets });
    await expect(
      pipeline.dispatch({ type: "OpenTicket", payload: { ticketId: 42 } }),
    ).rejects.toMatchObject({
      message: 'Command for "ticket" has no aggregate id',
      issues: [{ path: ["ticketId"], message: "Expected a non-empty string" }],
    });
  });

  it("treats a handler that returns nothing as producing no events", async () => {
    const { pipeline, storage } = await createKernelHarness({ registry: withTickets });
    expect(await pipeline.dispatch({ type: "TouchTicket", payload: { ticketId: "t-1" } })).toEqual({
      scheduled: false,
      aggregateType: "ticket",
      aggregateId: "t-1",
      version: 0,
      eventIds: [],
      eventTypes: [],
      position: 0,
    });
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("supports payload-less events", async () => {
    const { pipeline, storage } = await createKernelHarness();
    await pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    const loaded = await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.events[0]).toMatchObject({ type: "OrderArchived", payload: {} });
  });

  it("refuses events the aggregate does not define", async () => {
    const { pipeline } = await createKernelHarness();
    await expect(
      pipeline.dispatch({ type: "BreakOrder", payload: { orderId: "o-1" } }),
    ).rejects.toThrow(
      new ConfigurationError(
        'Command "BreakOrder" returned event "CustomerRegistered", which "order" does not define',
      ),
    );
  });

  it("validates event payloads produced by handlers", async () => {
    const { pipeline } = await createKernelHarness();
    await expect(
      pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: -5 } }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Invalid payload for event OrderPlaced",
    });
  });

  it("retries on a concurrency conflict with freshly loaded state", async () => {
    const { pipeline, storage } = await createKernelHarness();
    const original = storage.eventStore.append.bind(storage.eventStore);
    let interfered = false;
    storage.eventStore.append = async (args) => {
      if (!interfered) {
        interfered = true;
        await original({
          ...args,
          events: args.events.map((event) => ({ ...event, id: "sneaky", payload: { total: 7 } })),
        });
      }
      return original(args);
    };
    await expect(
      pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 42 } }),
    ).rejects.toMatchObject({ message: "Order already placed" });
    expect(sentMessages).toEqual(["placed o-1 v0"]);
    const loaded = await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.events.map((event) => event.id)).toEqual(["sneaky"]);
  });

  it("surfaces the conflict once retries are exhausted", async () => {
    const { pipeline, storage } = await createKernelHarness({
      config: { runtime: { commands: { concurrencyRetries: 1 } } },
    });
    storage.eventStore.append = async ({ expectedVersion }) => {
      throw new ConcurrencyError({ streamId: "order:o-1", expectedVersion, actualVersion: 99 });
    };
    await expect(
      pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 42 } }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    expect(sentMessages).toHaveLength(2);
    expect(placeOrderKeys).toEqual(["id-1", "id-1"]);
  });

  it("lets exactly one of two concurrent commands on a fresh aggregate win without retries", async () => {
    const { pipeline, storage } = await createKernelHarness({
      config: { runtime: { commands: { concurrencyRetries: 0 } } },
    });
    const results = await Promise.allSettled([
      pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 1 } }),
      pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 2 } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const loaded = await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.version).toBe(1);
  });

  it("schedules a command dispatched with a delay instead of executing it", async () => {
    const { pipeline, storage, clock } = await createKernelHarness();
    const result = await pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 42 },
      options: { delay: "5m" },
    });
    expect(result).toEqual({
      scheduled: true,
      aggregateType: "order",
      aggregateId: "o-1",
      executeAt: "2026-01-01T00:05:00.000Z",
    });
    expect(sentMessages).toEqual([]);
    const pending = await storage.scheduler.list();
    expect(pending).toEqual([
      {
        dedupeKey: "command:id-1",
        command: { type: "PlaceOrder", payload: { orderId: "o-1", total: 42 }, aggregateId: "o-1" },
        executeAt: "2026-01-01T00:05:00.000Z",
        context: { correlationId: "id-1", causationId: "id-1", depth: 0 },
        attempts: 0,
      },
    ]);
    clock.advance(1);
  });

  it("propagates the causal context and rejects chains that are too deep", async () => {
    const { pipeline, storage } = await createKernelHarness({
      config: { runtime: { policies: { maxChainDepth: 2 } } },
    });
    await pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 42 },
      context: { correlationId: "req-9", causationId: "evt-3", depth: 2 },
    });
    const loaded = await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.events[0]?.metadata).toMatchObject({ correlationId: "req-9", depth: 2 });
    await expect(
      pipeline.dispatch({
        type: "TouchOrder",
        payload: { orderId: "o-1" },
        context: { correlationId: "req-9", causationId: "evt-4", depth: 3 },
      }),
    ).rejects.toThrow(ChainDepthExceededError);
  });

  it("lets the caller set the correlation id of a new request", async () => {
    const { pipeline, storage } = await createKernelHarness();
    await pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 42 },
      options: { correlationId: "http-1" },
    });
    const loaded = await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.events[0]?.metadata.correlationId).toBe("http-1");
  });
});

type Builders = Record<string, (payload?: unknown) => unknown>;
const emitting =
  (...keys: readonly string[]) =>
  ({ events }: { events: Builders }) =>
    keys.map((key) => events[key]?.());

const withCases: Registry = {
  aggregates: {
    case: {
      events: {
        caseOpened: { begin: () => ({ status: "open" }) },
        caseNoted: { evolve: () => ({ noted: true }) },
        caseImported: { begin: () => ({ status: "imported" }) },
      },
      commands: {
        openCase: { module: { handler: emitting("caseOpened", "caseNoted") } },
        noteCase: { module: { handler: emitting("caseNoted") } },
        importCase: { module: { handler: emitting("caseImported") } },
        openCaseTwice: { module: { handler: emitting("caseOpened", "caseImported") } },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
};

describe("an aggregate whose events open it with begin", () => {
  it("starts with an event that exports begin, and takes later events through evolve", async () => {
    const { pipeline } = await createKernelHarness({ registry: withCases });
    await expect(
      pipeline.dispatch({ type: "OpenCase", payload: { caseId: "c-1" } }),
    ).resolves.toMatchObject({ eventTypes: ["CaseOpened", "CaseNoted"] });
    await expect(
      pipeline.dispatch({ type: "NoteCase", payload: { caseId: "c-1" } }),
    ).resolves.toMatchObject({ version: 3 });
    await expect(
      pipeline.dispatch({ type: "ImportCase", payload: { caseId: "c-2" } }),
    ).resolves.toMatchObject({ eventTypes: ["CaseImported"] });
  });

  it("refuses to store an aggregate that would start with an event without begin", async () => {
    const { pipeline, storage } = await createKernelHarness({ registry: withCases });
    const refused = pipeline.dispatch({ type: "NoteCase", payload: { caseId: "c-1" } });
    await expect(refused).rejects.toThrow(CreationOrderError);
    await expect(refused).rejects.toThrow(
      'Command "NoteCase" returned "CaseNoted" for case c-1, which does not exist yet: it must start with an event that exports begin',
    );
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("refuses an event that only exports begin on an aggregate that exists, within one command too", async () => {
    const { pipeline, storage } = await createKernelHarness({ registry: withCases });
    await pipeline.dispatch({ type: "OpenCase", payload: { caseId: "c-1" } });
    await expect(
      pipeline.dispatch({ type: "ImportCase", payload: { caseId: "c-1" } }),
    ).rejects.toThrow(
      'Command "ImportCase" returned "CaseImported" for case c-1, which exists already: "CaseImported" only exports begin',
    );
    await expect(
      pipeline.dispatch({ type: "OpenCaseTwice", payload: { caseId: "c-2" } }),
    ).rejects.toThrow(CreationOrderError);
    expect(await storage.eventStore.lastPosition()).toBe(2);
  });

  it("counts an aggregate holding only system events as not created", async () => {
    const { pipeline, storage } = await createKernelHarness({ registry: withCases });
    await storage.eventStore.append({
      aggregateType: "case",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [pending("ScheduledCommandFailed", 1, true)],
    });
    await expect(
      pipeline.dispatch({ type: "NoteCase", payload: { caseId: "c-1" } }),
    ).rejects.toThrow(CreationOrderError);
    await expect(
      pipeline.dispatch({ type: "OpenCase", payload: { caseId: "c-1" } }),
    ).resolves.toMatchObject({ version: 3 });
  });

  it("warns about a stored aggregate opened by an event without begin, and goes on", async () => {
    const recording = createRecordingLogger();
    const { pipeline, storage } = await createKernelHarness({
      registry: withCases,
      logger: recording.logger,
    });
    await storage.eventStore.append({
      aggregateType: "case",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [pending("CaseNoted", 1, false)],
    });
    await expect(
      pipeline.dispatch({ type: "NoteCase", payload: { caseId: "c-1" } }),
    ).resolves.toMatchObject({ version: 2 });
    expect(recording.entries).toContainEqual({
      level: "warn",
      message: "aggregate opened by an event without begin; its state may lack fields",
      fields: { aggregateType: "case", aggregateId: "c-1", eventType: "CaseNoted" },
    });
  });
});

const pending = (type: string, version: number, system: boolean) => ({
  id: `stored-${version}`,
  aggregateType: "case",
  aggregateId: "c-1",
  version,
  type,
  payload: {},
  timestamp: "2026-01-01T00:00:00.000Z",
  metadata: { correlationId: "c", causationId: "c", depth: 0, schemaVersion: 1, system },
});

describe("a command's time limit and signal", () => {
  const job = { jobId: "j-1" };

  const storedTypes = async ({ storage }: KernelHarness): Promise<string[]> =>
    (await storage.eventStore.load({ aggregateType: "job", aggregateId: "j-1" })).events.map(
      (event) => event.type,
    );

  it("rejects a handler that runs out of time, aborts its signal and stores nothing it returns late", async () => {
    const telemetry = installFakeTelemetry();
    onTestFinished(() => telemetry.restore());
    const { registry, started, finish } = slowJob();
    const harness = await createKernelHarness({ registry });
    const outcome = harness.pipeline.dispatch({ type: "RunJob", payload: job });
    const signal = await started;
    harness.clock.advance(29_999);
    expect(signal.aborted).toBe(false);
    harness.clock.advance(1);

    const error = await outcome.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HandlerTimeoutError);
    expect((error as Error).message).toBe("command RunJob did not finish within 30000ms");
    expect(signal.reason).toBe(error);
    expect(telemetry.counts.at(-1)?.attributes).toEqual({
      [ATTRIBUTES.commandType]: "RunJob",
      [ATTRIBUTES.outcome]: "failed",
    });
    finish();
    await drained();
    expect(await storedTypes(harness)).toEqual([]);
  });

  it("takes the time limit of the command's aggregate", async () => {
    const { registry, started } = slowJob();
    const { pipeline, clock } = await createKernelHarness({
      registry,
      config: {
        runtime: {
          commands: { timeout: "1m" },
          overrides: { job: { commands: { timeout: "1s" } } },
        },
      },
    });
    const outcome = pipeline.dispatch({ type: "RunJob", payload: job });
    await started;
    clock.advance(1_000);
    await expect(outcome).rejects.toThrow("command RunJob did not finish within 1000ms");
  });

  it("gives every retry after a concurrency conflict a time limit and a signal of its own", async () => {
    const signals: AbortSignal[] = [];
    let clock: KernelHarness["clock"] | undefined;
    const harness = await createKernelHarness({
      registry: withJob(({ signal, events }) => {
        signals.push(signal);
        clock?.advance(600);
        return [events.jobDone?.()];
      }),
      config: { runtime: { commands: { timeout: "1s" } } },
    });
    clock = harness.clock;
    const original = harness.storage.eventStore.append.bind(harness.storage.eventStore);
    let conflicted = false;
    harness.storage.eventStore.append = async (args) => {
      if (conflicted) return original(args);
      conflicted = true;
      throw new ConcurrencyError({
        streamId: "job:j-1",
        expectedVersion: args.expectedVersion,
        actualVersion: 1,
      });
    };

    await expect(
      harness.pipeline.dispatch({ type: "RunJob", payload: job }),
    ).resolves.toMatchObject({ version: 1, eventTypes: ["JobDone"] });
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    expect(harness.clock.pending()).toBe(0);
  });

  it("lets whoever dispatches withdraw the command while its handler runs", async () => {
    const { registry, started, finish } = slowJob();
    const harness = await createKernelHarness({ registry });
    const controller = new AbortController();
    const reason = new Error("client gave up");
    const outcome = harness.pipeline.dispatch({
      type: "RunJob",
      payload: job,
      options: { signal: controller.signal },
    });
    const signal = await started;
    controller.abort(reason);

    await expect(outcome).rejects.toBe(reason);
    expect(signal.reason).toBe(reason);
    expect(harness.clock.pending()).toBe(0);
    finish();
    await drained();
    expect(await storedTypes(harness)).toEqual([]);
  });

  it("never runs nor schedules a command whose signal is already aborted", async () => {
    let ran = false;
    const harness = await createKernelHarness({
      registry: withJob(() => {
        ran = true;
      }),
    });
    const reason = new Error("too late");
    await expect(
      harness.pipeline.dispatch({
        type: "RunJob",
        payload: job,
        options: { signal: AbortSignal.abort(reason) },
      }),
    ).rejects.toBe(reason);
    await expect(
      harness.pipeline.dispatch({
        type: "RunJob",
        payload: job,
        options: { delay: "1m", signal: AbortSignal.abort(reason) },
      }),
    ).rejects.toBe(reason);
    expect(ran).toBe(false);
    expect(await harness.storage.scheduler.list()).toEqual([]);
  });

  it("stores a withdrawn command only when its append had started", async () => {
    for (let ticks = 0; ticks < 12; ticks += 1) {
      const controller = new AbortController();
      let appending = false;
      let withdrawnFirst = false;
      const harness = await createKernelHarness({
        registry: withJob(({ events }) => {
          void (async () => {
            for (let tick = 0; tick < ticks; tick += 1) await undefined;
            withdrawnFirst = !appending;
            controller.abort(new Error("late"));
          })();
          return [events.jobDone?.()];
        }),
      });
      const original = harness.storage.eventStore.append.bind(harness.storage.eventStore);
      harness.storage.eventStore.append = (args) => {
        appending = true;
        return original(args);
      };
      const outcome = await harness.pipeline
        .dispatch({ type: "RunJob", payload: job, options: { signal: controller.signal } })
        .then(
          () => "stored",
          () => "withdrawn",
        );
      await drained();

      expect(outcome).toBe(withdrawnFirst ? "withdrawn" : "stored");
      expect(await storedTypes(harness)).toEqual(withdrawnFirst ? [] : ["JobDone"]);
    }
  });
});
