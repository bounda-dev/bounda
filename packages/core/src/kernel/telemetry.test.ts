import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError, ValidationError } from "../contracts/errors.ts";
import { silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import type { PayloadArgs } from "../modules/payload.ts";
import type { Registry } from "../modules/registry.ts";
import type { FieldsArgs } from "../modules/view.ts";
import { createApp } from "./app.ts";
import type { DeadLetters } from "./dead-letters/dead-letters.ts";
import { PROCESS_DEADLINE_COMMAND } from "./process/deadlines.ts";
import { createReactiveHarness } from "./reactive-harness.ts";
import { ATTRIBUTES, METRICS, SPAN_EVENTS, TELEMETRY_SCOPE, traced } from "./telemetry.ts";
import { type FakeTelemetry, installFakeTelemetry } from "./telemetry-fake.ts";
import { type OrderProcessConfigArgs, orderAggregateEntry } from "./test-support.ts";

let policyMode: "ok" | "domain" = "ok";

const registry = {
  aggregates: {
    order: {
      ...orderAggregateEntry(),
      policies: {
        notifyOnOrderPlaced: {
          module: {
            handler: async () => {
              if (policyMode === "domain") throw new ValidationError("no mail today", []);
            },
          },
        },
      },
      processes: {
        orderPayment: {
          module: {
            config: ({ events }: OrderProcessConfigArgs<"OrderPlaced" | "OrderPaid">) => ({
              startedBy: [events.order.OrderPlaced],
              completedBy: [events.order.OrderPaid],
              timeout: "1h",
            }),
            state: ({ z }: PayloadArgs) => z.object({ paid: z.boolean().default(false) }),
          },
          handlers: { order: { orderPaid: { handler: () => ({ paid: true }) } } },
          deadlines: { timeout: { handler: () => undefined } },
        },
      },
    },
  },
  readModels: {
    orderSummary: {
      view: { fields: ({ f }: FieldsArgs) => ({ orderId: f.string().primaryKey() }) },
      projections: {
        order: {
          orderPlaced: {
            project: async ({
              event,
              table,
            }: {
              event: { aggregateId: string };
              table: { upsert: (row: object) => Promise<void> };
            }) => {
              await table.upsert({ orderId: event.aggregateId });
            },
          },
        },
      },
      queries: {
        getOrder: {
          payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
          handler: ({
            query,
            table,
          }: {
            query: { payload: { orderId: string } };
            table: { findOne: (where: object) => Promise<unknown> };
          }) => table.findOne({ orderId: query.payload.orderId }),
        },
      },
    },
  },
} satisfies Registry;

const setUp = async () => {
  const telemetry = installFakeTelemetry();
  const app = await createApp({
    registry,
    config: {
      storage: memory(),
      ports: { order: { notifier: "memory" } },
      runtime: { policies: { retry: { strategy: "none" } } },
    },
    logger: silentLogger,
  });
  return { telemetry, app };
};

const named = (telemetry: FakeTelemetry, prefix: string) =>
  telemetry.spans.filter((span) => span.name.startsWith(prefix));

let active: FakeTelemetry | null = null;

afterEach(() => {
  active?.restore();
  active = null;
  policyMode = "ok";
});

describe("telemetry", () => {
  it("traces a command with its outcome and counts it", async () => {
    const { telemetry, app } = await setUp();
    active = telemetry;
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await expect(app.commands.placeOrder({ orderId: "o-1", total: 10 })).rejects.toBeInstanceOf(
      DomainError,
    );
    await app.commands.payOrder({ orderId: "o-1", method: "card" }, { delay: "1m" });

    const [stored, rejected, scheduled] = named(telemetry, "bounda.command");
    expect(stored).toEqual({
      name: "bounda.command PlaceOrder",
      attributes: {
        [ATTRIBUTES.commandType]: "PlaceOrder",
        [ATTRIBUTES.aggregateType]: "order",
        [ATTRIBUTES.aggregateId]: "o-1",
        [ATTRIBUTES.correlationId]: expect.any(String),
        [ATTRIBUTES.causationId]: expect.any(String),
        [ATTRIBUTES.outcome]: "stored",
        [ATTRIBUTES.eventCount]: 1,
        [ATTRIBUTES.aggregateVersion]: 0,
        [ATTRIBUTES.foldEvents]: 0,
      },
      status: { code: SpanStatusCode.UNSET },
      exceptions: [],
      ended: true,
    });
    expect(rejected).toMatchObject({
      name: "bounda.command PlaceOrder",
      attributes: {
        [ATTRIBUTES.outcome]: "rejected",
        [ATTRIBUTES.aggregateVersion]: 1,
        [ATTRIBUTES.foldEvents]: 1,
      },
      status: { code: SpanStatusCode.UNSET },
      exceptions: [],
      ended: true,
    });
    expect(telemetry.spanEvents).toEqual([
      {
        span: "bounda.command PlaceOrder",
        name: SPAN_EVENTS.commandRejected,
        attributes: { [ATTRIBUTES.rejected]: "AlreadyPlaced" },
      },
    ]);
    expect(scheduled).toMatchObject({
      name: "bounda.command PayOrder",
      attributes: { [ATTRIBUTES.outcome]: "scheduled" },
      ended: true,
    });
    expect(scheduled?.attributes).not.toHaveProperty([ATTRIBUTES.foldEvents]);
    expect(telemetry.counts.filter((count) => count.metric === METRICS.foldEvents)).toEqual([
      { metric: METRICS.foldEvents, value: 0, attributes: { [ATTRIBUTES.aggregateType]: "order" } },
      { metric: METRICS.foldEvents, value: 1, attributes: { [ATTRIBUTES.aggregateType]: "order" } },
    ]);
    expect(telemetry.instruments).toContainEqual({
      metric: METRICS.foldEvents,
      description: "Events folded into an aggregate's state per load, by aggregate type",
      unit: "{event}",
    });
    expect(telemetry.counts.filter((count) => count.metric === METRICS.commands)).toEqual([
      {
        metric: METRICS.commands,
        value: 1,
        attributes: { [ATTRIBUTES.commandType]: "PlaceOrder", [ATTRIBUTES.outcome]: "stored" },
      },
      {
        metric: METRICS.commands,
        value: 1,
        attributes: { [ATTRIBUTES.commandType]: "PlaceOrder", [ATTRIBUTES.outcome]: "rejected" },
      },
      {
        metric: METRICS.commands,
        value: 1,
        attributes: { [ATTRIBUTES.commandType]: "PayOrder", [ATTRIBUTES.outcome]: "scheduled" },
      },
    ]);
    await app.stop();
  });

  it("puts who acts on a command's span", async () => {
    const { telemetry, app } = await setUp();
    active = telemetry;
    await app.as("user-1").commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.commands.placeOrder({ orderId: "o-2", total: 10 });
    const [bound, anonymous] = named(telemetry, "bounda.command");
    expect(bound?.attributes[ATTRIBUTES.actor]).toBe("user-1");
    expect(anonymous?.attributes).not.toHaveProperty(ATTRIBUTES.actor);
    await app.stop();
  });

  it("puts who acts on the spans of what follows from a command, of queries and of client operations", async () => {
    const { telemetry, app } = await setUp();
    active = telemetry;
    const user = app.as("user-1");
    await user.commands.placeOrder({ orderId: "o-1", total: 10 });
    await user.commands.payOrder({ orderId: "o-1", method: "card" }, { delay: "0s" });
    await app.runUntilIdle();
    await user.queries.getOrder({ orderId: "o-1" });
    await app.queries.getOrder({ orderId: "o-1" });
    await user.forget("p-1");
    await user.restrict("p-2");
    await user.unrestrict("p-2");
    await user.exportPersonalData("p-2");
    await user.deadLetters.list();
    // The bound client's type offers neither, as an operator asks those of the app.
    const letters = user.deadLetters as DeadLetters;
    await letters.count();
    await expect(letters.get("missing")).resolves.toBeNull();
    await expect(user.deadLetters.retry("missing")).rejects.toThrow();
    await expect(user.deadLetters.discard("missing")).rejects.toThrow();
    await user.rebuildReadModel("orderSummary");
    await app.forget("p-3");

    const actorOf = (prefix: string) =>
      named(telemetry, prefix).map((span) => span.attributes[ATTRIBUTES.actor]);
    // The rebuild projects the event again, still under the actor of whoever placed the order.
    expect(actorOf("bounda.projection")).toEqual(["user-1", "user-1"]);
    expect(actorOf("bounda.policy")).toEqual(["user-1"]);
    expect(actorOf("bounda.process")).toEqual(["user-1"]);
    expect(actorOf("bounda.scheduled")).toEqual(["user-1"]);
    expect(named(telemetry, "bounda.query").map((span) => [span.name, span.attributes])).toEqual([
      [
        "bounda.query GetOrder",
        {
          [ATTRIBUTES.queryType]: "GetOrder",
          [ATTRIBUTES.readModel]: "orderSummary",
          [ATTRIBUTES.actor]: "user-1",
        },
      ],
      [
        "bounda.query GetOrder",
        { [ATTRIBUTES.queryType]: "GetOrder", [ATTRIBUTES.readModel]: "orderSummary" },
      ],
    ]);
    expect(
      named(telemetry, "bounda.operation").map((span) => [span.name, span.attributes]),
    ).toEqual([
      ...[
        "forget",
        "restrict",
        "unrestrict",
        "exportPersonalData",
        "deadLetters.list",
        "deadLetters.count",
        "deadLetters.get",
        "deadLetters.retry",
        "deadLetters.discard",
        "rebuildReadModel",
      ].map((operation) => [
        `bounda.operation ${operation}`,
        {
          [ATTRIBUTES.operation]: operation,
          [ATTRIBUTES.actor]: "user-1",
          ...(operation === "deadLetters.retry" || operation === "deadLetters.discard"
            ? { "error.type": "NotFoundError" }
            : {}),
        },
      ]),
      ["bounda.operation forget", { [ATTRIBUTES.operation]: "forget" }],
    ]);
    const failed = named(telemetry, "bounda.operation deadLetters.retry")[0];
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
    await app.stop();
  });

  it("tells on a command's span how it loaded its aggregate, and on the snapshot batch what it wrote", async () => {
    const telemetry = installFakeTelemetry();
    active = telemetry;
    const app = await createApp({
      registry: {
        ...registry,
        aggregates: { order: { ...registry.aggregates.order, stateFingerprint: "fp" } },
      },
      config: {
        storage: memory(),
        ports: { order: { notifier: "memory" } },
        runtime: {
          policies: { retry: { strategy: "none" } },
          overrides: { order: { snapshot: { every: 1 } } },
        },
      },
      logger: silentLogger,
    });
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.runUntilIdle();
    await app.commands.payOrder({ orderId: "o-1", method: "card" });

    const [placed, paid] = named(telemetry, "bounda.command");
    expect(placed?.attributes).toMatchObject({
      [ATTRIBUTES.snapshotOutcome]: "missing",
      [ATTRIBUTES.aggregateVersion]: 0,
      [ATTRIBUTES.foldEvents]: 0,
    });
    expect(placed?.attributes).not.toHaveProperty([ATTRIBUTES.snapshotVersion]);
    expect(paid?.attributes).toMatchObject({
      [ATTRIBUTES.snapshotOutcome]: "used",
      [ATTRIBUTES.snapshotVersion]: 1,
      [ATTRIBUTES.aggregateVersion]: 1,
      [ATTRIBUTES.foldEvents]: 0,
    });
    const [batch] = named(telemetry, "bounda.subscriber snapshot:order");
    expect(batch?.attributes[ATTRIBUTES.snapshotVersion]).toBe(1);
    expect(
      telemetry.spanEvents.filter((event) => event.name === SPAN_EVENTS.snapshotWritten),
    ).toEqual([
      {
        span: "bounda.subscriber snapshot:order",
        name: SPAN_EVENTS.snapshotWritten,
        attributes: { [ATTRIBUTES.aggregateId]: "o-1", [ATTRIBUTES.snapshotVersion]: 1 },
      },
    ]);
    await app.stop();
  });

  it("traces every batch, projection, policy, process and scheduled run with the correlation id", async () => {
    const { telemetry, app } = await setUp();
    active = telemetry;
    const placed = await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.commands.payOrder({ orderId: "o-1", method: "card" }, { delay: "0s" });
    await app.runUntilIdle();
    const correlationId = named(telemetry, "bounda.command")[0]?.attributes[
      ATTRIBUTES.correlationId
    ];
    expect(placed.scheduled).toBe(false);

    expect(
      named(telemetry, "bounda.subscriber").map((span) => [span.name, span.attributes]),
    ).toEqual(
      expect.arrayContaining([
        [
          "bounda.subscriber projection:orderSummary",
          expect.objectContaining({
            [ATTRIBUTES.subscriber]: "projection:orderSummary",
            [ATTRIBUTES.subscriberKind]: "projection",
            [ATTRIBUTES.afterPosition]: 0,
            [ATTRIBUTES.eventCount]: 1,
            [ATTRIBUTES.outcome]: "advanced",
          }),
        ],
        [
          "bounda.subscriber policies",
          expect.objectContaining({ [ATTRIBUTES.subscriberKind]: "policy" }),
        ],
        [
          "bounda.subscriber processes",
          expect.objectContaining({ [ATTRIBUTES.subscriberKind]: "process" }),
        ],
      ]),
    );
    expect(named(telemetry, "bounda.projection")).toEqual([
      expect.objectContaining({
        name: "bounda.projection orderSummary.order.orderPlaced",
        attributes: expect.objectContaining({
          [ATTRIBUTES.readModel]: "orderSummary",
          [ATTRIBUTES.projection]: "order.orderPlaced",
          [ATTRIBUTES.eventType]: "OrderPlaced",
          [ATTRIBUTES.aggregateId]: "o-1",
          [ATTRIBUTES.correlationId]: correlationId,
        }),
        ended: true,
      }),
    ]);
    expect(named(telemetry, "bounda.policy")).toEqual([
      expect.objectContaining({
        name: "bounda.policy order.notifyOnOrderPlaced",
        attributes: expect.objectContaining({
          [ATTRIBUTES.policy]: "order.notifyOnOrderPlaced",
          [ATTRIBUTES.eventType]: "OrderPlaced",
          [ATTRIBUTES.correlationId]: correlationId,
          [ATTRIBUTES.attempt]: 1,
        }),
        status: { code: SpanStatusCode.UNSET },
      }),
    ]);
    expect(named(telemetry, "bounda.scheduled")).toEqual([
      expect.objectContaining({
        name: "bounda.scheduled PayOrder",
        attributes: expect.objectContaining({
          [ATTRIBUTES.commandType]: "PayOrder",
          [ATTRIBUTES.aggregateId]: "o-1",
          [ATTRIBUTES.attempt]: 1,
        }),
        ended: true,
      }),
    ]);
    expect(named(telemetry, "bounda.process")).toEqual([
      expect.objectContaining({
        name: "bounda.process order.orderPayment",
        attributes: expect.objectContaining({
          [ATTRIBUTES.process]: "order.orderPayment",
          [ATTRIBUTES.eventType]: "OrderPaid",
          [ATTRIBUTES.attempt]: 1,
        }),
      }),
    ]);
    await app.stop();
  });

  it("marks failing handlers, counts dead letters and observes the lag per subscriber", async () => {
    policyMode = "domain";
    const { telemetry, app } = await setUp();
    active = telemetry;
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    expect(await telemetry.observe()).toEqual(
      expect.arrayContaining([
        { metric: METRICS.lag, value: 1, attributes: { [ATTRIBUTES.subscriber]: "policies" } },
        {
          metric: METRICS.lag,
          value: 1,
          attributes: { [ATTRIBUTES.subscriber]: "projection:orderSummary" },
        },
      ]),
    );
    await app.runUntilIdle();
    expect(named(telemetry, "bounda.policy")[0]).toMatchObject({
      attributes: { "error.type": "ValidationError" },
      status: { code: SpanStatusCode.ERROR, message: "ValidationError (VALIDATION_FAILED)" },
      exceptions: [],
    });
    expect(telemetry.spanEvents.filter((event) => event.name === "exception")).toEqual([
      {
        span: "bounda.policy order.notifyOnOrderPlaced",
        name: "exception",
        attributes: {
          "exception.type": "ValidationError",
          [ATTRIBUTES.errorCode]: "VALIDATION_FAILED",
        },
      },
    ]);
    expect(telemetry.instruments).toEqual(
      expect.arrayContaining([
        {
          metric: METRICS.commands,
          description: "Commands dispatched, by type and outcome",
          unit: "{command}",
        },
        {
          metric: METRICS.lag,
          description: "Events each subscriber is behind the head of the stream",
          unit: "{event}",
        },
        {
          metric: METRICS.deadLetters,
          description: "Handler runs that gave up, by kind, handler and error type",
          unit: "{letter}",
        },
      ]),
    );
    expect(telemetry.counts).toContainEqual({
      metric: METRICS.deadLetters,
      value: 1,
      attributes: {
        [ATTRIBUTES.handlerKind]: "policy",
        [ATTRIBUTES.handler]: "order.notifyOnOrderPlaced",
        [ATTRIBUTES.outcome]: "terminal",
      },
    });
    expect((await telemetry.observe()).every((entry) => entry.value === 0)).toBe(true);
    await app.stop();
    expect(await telemetry.observe()).toEqual([]);
  });

  it("traces a process deadline through the scheduled run that fires it", async () => {
    const telemetry = installFakeTelemetry();
    active = telemetry;
    const harness = await createReactiveHarness({
      registry,
      config: { runtime: { policies: { retry: { strategy: "none" } } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(2 * 3_600_000);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(named(telemetry, "bounda.scheduled")).toEqual([
      expect.objectContaining({
        name: `bounda.scheduled ${PROCESS_DEADLINE_COMMAND}`,
        attributes: expect.objectContaining({ [ATTRIBUTES.aggregateId]: "o-1" }),
        ended: true,
      }),
    ]);
    expect(named(telemetry, "bounda.process")).toEqual([
      expect.objectContaining({
        name: "bounda.process order.orderPayment at timeout",
        attributes: {
          [ATTRIBUTES.process]: "order.orderPayment",
          [ATTRIBUTES.aggregateType]: "order",
          [ATTRIBUTES.aggregateId]: "o-1",
          [ATTRIBUTES.correlationId]: expect.any(String),
        },
        ended: true,
      }),
    ]);
  });

  it("is a no-op without a provider and still runs the work", async () => {
    let ran = false;
    await expect(
      traced({
        name: `${TELEMETRY_SCOPE} test`,
        errorText: "omit",
        run: async (span) => {
          span.setAttribute("x", 1);
          ran = true;
          return 7;
        },
      }),
    ).resolves.toBe(7);
    expect(ran).toBe(true);
    await expect(
      traced({
        name: "fails",
        errorText: "omit",
        run: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });
});
