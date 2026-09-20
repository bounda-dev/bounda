import { describe, expect, it } from "vitest";
import {
  ChainDepthExceededError,
  ConcurrencyError,
  ConfigurationError,
  DomainError,
  NotFoundError,
  ValidationError,
} from "../../contracts/errors.ts";
import type { Registry } from "../../modules/registry.ts";
import { createKernelHarness, orderRegistry, sentMessages } from "../test-support.ts";

const withTickets: Registry = {
  aggregates: {
    ...orderRegistry.aggregates,
    ticket: {
      events: {
        ticketOpened: { apply: ({ state }: { state: object }) => state },
        ticketTagged: { apply: ({ state }: { state: object }) => state },
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
  it("validates, runs the handler with collaborators and appends with the loaded version", async () => {
    const { pipeline, storage } = await createKernelHarness();
    const result = await pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 42 },
    });
    expect(result).toEqual({
      scheduled: false,
      aggregateId: "o-1",
      version: 1,
      eventIds: ["id-2"],
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
    ).rejects.toThrow(DomainError);
  });

  it("returns domain errors untouched and persists nothing", async () => {
    const { pipeline, storage } = await createKernelHarness();
    await expect(
      pipeline.dispatch({ type: "PayOrder", payload: { orderId: "o-1", method: "card" } }),
    ).rejects.toThrow("Only placed orders can be paid");
    expect(await storage.eventStore.lastPosition()).toBe(0);
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
    expect(result).toEqual({ scheduled: false, aggregateId: "o-1", version: 0, eventIds: [] });
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("numbers the events of one command consecutively after the loaded version", async () => {
    const { pipeline, storage } = await createKernelHarness({ registry: withTickets });
    const result = await pipeline.dispatch({ type: "OpenTicket", payload: { ticketId: "t-1" } });
    expect(result).toMatchObject({ version: 2, eventIds: ["id-2", "id-3"] });
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
      aggregateId: "t-1",
      version: 0,
      eventIds: [],
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
    ).rejects.toThrow("Order already placed");
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

  it("schedules delayed commands instead of executing them", async () => {
    const { pipeline, storage, clock } = await createKernelHarness();
    const result = await pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 42 },
      options: { delay: "5m" },
    });
    expect(result).toEqual({
      scheduled: true,
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
