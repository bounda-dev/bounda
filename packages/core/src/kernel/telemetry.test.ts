import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../contracts/errors.ts";
import { silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import type { PayloadArgs } from "../modules/payload.ts";
import type { ProcessConfigArgs } from "../modules/process.ts";
import type { Registry } from "../modules/registry.ts";
import type { FieldsArgs } from "../modules/view.ts";
import { createApp } from "./app.ts";
import { PROCESS_TIMEOUT_COMMAND } from "./process/runner.ts";
import { createReactiveHarness } from "./reactive-harness.ts";
import { ATTRIBUTES, METRICS, TELEMETRY_SCOPE, traced } from "./telemetry.ts";
import { type FakeTelemetry, installFakeTelemetry } from "./telemetry-fake.ts";
import { orderAggregateEntry } from "./test-support.ts";

let policyMode: "ok" | "domain" = "ok";

const registry = {
  aggregates: {
    order: {
      ...orderAggregateEntry(),
      policies: {
        notifyOnOrderPlaced: {
          handler: async () => {
            if (policyMode === "domain") throw new DomainError("no mail today");
          },
        },
      },
      processes: {
        orderPayment: {
          module: {
            config: ({ events }: ProcessConfigArgs<"OrderPlaced" | "OrderPaid">) => ({
              startedBy: [events.OrderPlaced],
              completedBy: [events.OrderPaid],
              timeout: "1h",
            }),
            state: ({ z }: PayloadArgs) => z.object({ paid: z.boolean().default(false) }),
          },
          handlers: { orderPaid: { handler: () => ({ paid: true }) } },
          timeout: { handler: () => undefined },
        },
      },
    },
  },
  readModels: {
    orderSummary: {
      view: { fields: ({ f }: FieldsArgs) => ({ orderId: f.string().primaryKey() }) },
      projections: {
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
      queries: {},
    },
  },
} satisfies Registry;

const setUp = async () => {
  const telemetry = installFakeTelemetry();
  const app = await createApp({
    registry,
    config: {
      storage: memory(),
      commands: { placeOrder: { notifier: { use: "memory" } } },
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
      },
      status: { code: SpanStatusCode.UNSET },
      exceptions: [],
      ended: true,
    });
    expect(rejected).toMatchObject({
      name: "bounda.command PlaceOrder",
      status: { code: SpanStatusCode.ERROR, message: "Order already placed" },
      exceptions: ["Order already placed"],
      ended: true,
    });
    expect(rejected?.attributes).not.toHaveProperty(ATTRIBUTES.outcome);
    expect(scheduled).toMatchObject({
      name: "bounda.command PayOrder",
      attributes: { [ATTRIBUTES.outcome]: "scheduled" },
      ended: true,
    });
    expect(telemetry.counts).toEqual([
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

  it("traces every batch, projection, policy, process and scheduled run with the correlation id", async () => {
    const { telemetry, app } = await setUp();
    active = telemetry;
    const placed = await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.commands.payOrder({ orderId: "o-1", method: "card" }, { delay: "0s" });
    await app.processUntilIdle();
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
        name: "bounda.projection orderSummary.orderPlaced",
        attributes: expect.objectContaining({
          [ATTRIBUTES.readModel]: "orderSummary",
          [ATTRIBUTES.projection]: "orderPlaced",
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
    await app.processUntilIdle();
    expect(named(telemetry, "bounda.policy")[0]).toMatchObject({
      status: { code: SpanStatusCode.ERROR, message: "no mail today" },
      exceptions: ["no mail today"],
    });
    expect(telemetry.counts).toContainEqual({
      metric: METRICS.deadLetters,
      value: 1,
      attributes: {
        [ATTRIBUTES.subscriberKind]: "policy",
        [ATTRIBUTES.subscriber]: "order.notifyOnOrderPlaced",
        [ATTRIBUTES.outcome]: "terminal",
      },
    });
    expect((await telemetry.observe()).every((entry) => entry.value === 0)).toBe(true);
    await app.stop();
    expect(await telemetry.observe()).toEqual([]);
  });

  it("traces a process timeout through the scheduled run that fires it", async () => {
    const telemetry = installFakeTelemetry();
    active = telemetry;
    const harness = await createReactiveHarness({
      registry,
      config: { runtime: { policies: { retry: { strategy: "none" } } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    harness.clock.advance(2 * 3_600_000);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(named(telemetry, "bounda.scheduled")).toEqual([
      expect.objectContaining({
        name: `bounda.scheduled ${PROCESS_TIMEOUT_COMMAND}`,
        attributes: expect.objectContaining({ [ATTRIBUTES.aggregateId]: "o-1" }),
        ended: true,
      }),
    ]);
    expect(named(telemetry, "bounda.process")).toEqual([
      expect.objectContaining({
        name: "bounda.process order.orderPayment timeout",
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
        run: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });
});
