import type { StoragePorts } from "../adapter/adapter.ts";
import { resolveConfig } from "../config/schema.ts";
import type { Config, ResolvedConfig } from "../config/types.ts";
import { createFixedClock, type FixedClock } from "../contracts/clock.ts";
import { DomainError } from "../contracts/errors.ts";
import { createSequentialIdGenerator } from "../contracts/ids.ts";
import { silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import type { PayloadArgs } from "../modules/payload.ts";
import type { Registry } from "../modules/registry.ts";
import { buildAggregates } from "./aggregate/build-aggregates.ts";
import type { AggregatesRuntime } from "./aggregate/runtime.ts";
import { createCommandPipeline } from "./command/pipeline.ts";

interface OrderState {
  readonly status: "new" | "placed" | "paid";
  readonly total: number;
}

/**
 * The order aggregate used by kernel tests, written as a user would in module style.
 */
export const orderRegistry: Registry = {
  aggregates: {
    order: orderAggregateEntry(),
  },
  readModels: {},
};

/**
 * The order aggregate entry on its own, for tests that extend it with policies or processes.
 */
export function orderAggregateEntry(): Registry["aggregates"][string] {
  return {
    state: { initialState: { status: "new", total: 0 } satisfies OrderState },
    events: {
      orderPlaced: {
        payload: ({ z }: PayloadArgs) => z.object({ total: z.number().positive() }),
        apply: ({
          state,
          event,
        }: {
          state: OrderState;
          event: { payload: { total: number } };
        }) => ({
          ...state,
          status: "placed" as const,
          total: event.payload.total,
        }),
      },
      orderPaid: {
        payload: ({ z }: PayloadArgs) => z.object({ method: z.enum(["card", "transfer"]) }),
        apply: ({ state }: { state: OrderState }) => ({ ...state, status: "paid" as const }),
      },
      orderArchived: {
        apply: ({ state }: { state: OrderState }) => state,
      },
    },
    commands: {
      placeOrder: {
        module: {
          payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string(), total: z.number() }),
          handler: async ({
            command,
            state,
            events,
            notifier,
          }: {
            command: { payload: { orderId: string; total: number }; aggregateId: string };
            state: OrderState & { version: number };
            events: Record<string, (payload?: unknown) => unknown>;
            notifier: { send: (message: string) => void };
          }) => {
            if (state.status !== "new") throw new DomainError("Order already placed");
            notifier.send(`placed ${command.aggregateId} v${state.version}`);
            return [events.orderPlaced?.({ total: command.payload.total })];
          },
        },
        collaborators: {
          notifier: {
            memory: { send: (message: string) => sentMessages.push(message) },
            silent: { send: () => {} },
          },
        },
      },
      payOrder: {
        module: {
          payload: ({ z }: PayloadArgs) =>
            z.object({ orderId: z.string(), method: z.enum(["card", "transfer"]) }),
          handler: ({
            command,
            state,
            events,
          }: {
            command: { payload: { method: "card" | "transfer" } };
            state: OrderState;
            events: Record<string, (payload?: unknown) => unknown>;
          }) => {
            if (state.status !== "placed") throw new DomainError("Only placed orders can be paid");
            return [events.orderPaid?.({ method: command.payload.method })];
          },
        },
      },
      archiveOrder: {
        module: {
          payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
          handler: ({ events }: { events: Record<string, (payload?: unknown) => unknown> }) => [
            events.orderArchived?.(),
          ],
        },
      },
      touchOrder: {
        module: {
          payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
          handler: () => [],
        },
      },
      breakOrder: {
        module: {
          payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
          handler: () => [{ type: "CustomerRegistered", payload: {} }],
        },
      },
    },
    policies: {},
    processes: {},
  };
}

/**
 * Messages sent through the in-memory notifier collaborator, reset by `createKernelHarness`.
 */
export const sentMessages: string[] = [];

export interface KernelHarness {
  readonly storage: StoragePorts;
  readonly config: ResolvedConfig;
  readonly aggregates: AggregatesRuntime;
  readonly clock: FixedClock;
  readonly pipeline: ReturnType<typeof createCommandPipeline>;
}

export interface CreateKernelHarnessArgs {
  readonly config?: Partial<Omit<Config, "storage">>;
  readonly registry?: Registry;
}

export interface CreateKernelHarnessFunction {
  (args?: CreateKernelHarnessArgs): Promise<KernelHarness>;
}

/**
 * Boots the order aggregate on the in-memory adapter with deterministic ids and clock.
 */
export const createKernelHarness: CreateKernelHarnessFunction = async ({
  config: overrides = {},
  registry = orderRegistry,
} = {}) => {
  sentMessages.length = 0;
  const adapter = memory();
  const storage = await adapter.createStorage({ logger: silentLogger });
  const config = resolveConfig({
    storage: adapter,
    commands: { placeOrder: { notifier: { use: "memory" } } },
    ...overrides,
  });
  const aggregates = buildAggregates({ registry, config });
  const clock = createFixedClock();
  const pipeline = createCommandPipeline({
    aggregates,
    eventStore: storage.eventStore,
    scheduler: storage.scheduler,
    config,
    ids: createSequentialIdGenerator(),
    clock,
    logger: silentLogger,
  });
  return { storage, config, aggregates, clock, pipeline };
};
