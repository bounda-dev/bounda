import { expect, vi } from "vitest";
import type { StoragePorts } from "../adapter/adapter.ts";
import { selectCollaborators } from "../config/collaborators.ts";
import { resolveConfig } from "../config/schema.ts";
import type { CollaboratorsConfig, Config, ResolvedConfig } from "../config/types.ts";
import { createFixedClock, type FixedClock } from "../contracts/clock.ts";
import { createSequentialIdGenerator } from "../contracts/ids.ts";
import { type LogFields, type Logger, silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import type { RejectFunction } from "../modules/command.ts";
import type { PayloadArgs } from "../modules/payload.ts";
import type { Registry } from "../modules/registry.ts";
import { buildAggregates } from "./aggregate/build-aggregates.ts";
import { type AggregateCollaborators, createCollaborators } from "./aggregate/collaborators.ts";
import type { AggregatesRuntime } from "./aggregate/runtime.ts";
import { createCommandPipeline } from "./command/pipeline.ts";

interface OrderState {
  readonly status: "new" | "placed" | "paid";
  readonly total: number;
}

/**
 * The order aggregate with its precise types, for tests that extend it with policies or processes
 * and want typed facades.
 */
export const orderAggregate = {
  state: { initialState: { status: "new", total: 0 } satisfies OrderState },
  events: {
    orderPlaced: {
      payload: ({ z }: PayloadArgs) => z.object({ total: z.number().positive() }),
      apply: ({ state, event }: { state: OrderState; event: { payload: { total: number } } }) => ({
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
        rejections: () => ({ AlreadyPlaced: "Order already placed" }),
        handler: async ({
          command,
          state,
          events,
          notifier,
          idempotencyKey,
          reject,
        }: {
          command: { payload: { orderId: string; total: number }; aggregateId: string };
          state: OrderState & { version: number };
          events: Record<string, (payload?: unknown) => unknown>;
          notifier: { send: (message: string) => void };
          idempotencyKey: string;
          reject: RejectFunction<"AlreadyPlaced">;
        }) => {
          placeOrderKeys.push(idempotencyKey);
          if (state.status !== "new") return reject("AlreadyPlaced");
          notifier.send(`placed ${command.aggregateId} v${state.version}`);
          return [events.orderPlaced?.({ total: command.payload.total })];
        },
      },
    },
    payOrder: {
      module: {
        payload: ({ z }: PayloadArgs) =>
          z.object({ orderId: z.string(), method: z.enum(["card", "transfer"]) }),
        rejections: ({ state }: { state: OrderState }) => ({
          NotPlaced: `Only placed orders can be paid; this one is ${state.status}`,
        }),
        handler: ({
          command,
          state,
          events,
          reject,
        }: {
          command: { payload: { method: "card" | "transfer" } };
          state: OrderState;
          events: Record<string, (payload?: unknown) => unknown>;
          reject: RejectFunction<"NotPlaced">;
        }) => {
          if (state.status !== "placed") throw reject("NotPlaced");
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
  collaborators: {
    notifier: {
      memory: { default: { send: (message: string) => sentMessages.push(message) } },
      silent: { default: { send: () => {} } },
    },
  },
} as const satisfies Registry["aggregates"][string];

export const orderAggregateEntry = (): typeof orderAggregate => orderAggregate;

/**
 * The order aggregate used by kernel tests, written as a user would in module style.
 */
export const orderRegistry: Registry = {
  aggregates: { order: orderAggregate },
  readModels: {},
};

export interface JobHandlerArgs {
  readonly signal: AbortSignal;
  readonly events: Record<string, (payload?: unknown) => unknown>;
}

export interface WithJobFunction {
  (handler: (args: JobHandlerArgs) => unknown, base?: Registry): Registry;
}

/**
 * `base` plus a `job` aggregate whose one command, `RunJob` (`{ jobId }`), runs `handler`, and
 * whose one event is `JobDone`: for tests that decide when a command finishes.
 */
export const withJob: WithJobFunction = (handler, base = { aggregates: {}, readModels: {} }) => ({
  ...base,
  aggregates: {
    ...base.aggregates,
    job: {
      events: { jobDone: { apply: ({ state }: { state: object }) => state } },
      commands: { runJob: { module: { handler } } },
      policies: {},
      processes: {},
    },
  },
});

export interface SlowJob {
  readonly registry: Registry;
  /**
   * Resolves with the handler's signal once `RunJob`'s handler runs.
   */
  readonly started: Promise<AbortSignal>;
  /**
   * Lets the handler return `JobDone`; until then it waits.
   */
  finish(): void;
}

export interface SlowJobFunction {
  (base?: Registry): SlowJob;
}

export const slowJob: SlowJobFunction = (base) => {
  const started = Promise.withResolvers<AbortSignal>();
  const finished = Promise.withResolvers<void>();
  const registry = withJob(async ({ signal, events }) => {
    started.resolve(signal);
    await finished.promise;
    return [events.jobDone?.()];
  }, base);
  return { registry, started: started.promise, finish: () => finished.resolve() };
};

/**
 * The `collaborators` configuration kernel tests boot with: the in-memory notifier for a registry
 * built on `orderAggregate`, nothing for any other.
 */
export const defaultCollaborators = (registry: Registry): CollaboratorsConfig =>
  registry.aggregates.order?.collaborators?.notifier === undefined
    ? {}
    : { order: { notifier: "memory" } };

/**
 * What `createCollaborators` builds, chosen synchronously, for kernel tests that build aggregates
 * by hand from a registry whose implementations are all default exports.
 */
export interface ChooseCollaboratorsFunction {
  (registry: Registry, config: ResolvedConfig): AggregateCollaborators;
}

export const chooseCollaborators: ChooseCollaboratorsFunction = (registry, config) =>
  Object.fromEntries(
    Object.entries(registry.aggregates).map(([aggregate, entry]) => [
      aggregate,
      Object.fromEntries(
        Object.entries(
          selectCollaborators({
            aggregate,
            implementations: entry.collaborators ?? {},
            config: config.collaborators[aggregate],
          }),
        ).map(([port, module]) => [port, module.default]),
      ),
    ]),
  );

/**
 * Messages sent through the in-memory notifier collaborator, reset by `createKernelHarness`.
 */
export const sentMessages: string[] = [];

/**
 * The `idempotencyKey` of every run of the `placeOrder` handler, reset by `createKernelHarness`.
 */
export const placeOrderKeys: string[] = [];

export interface LogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields?: LogFields;
}

export interface RecordingLogger {
  readonly logger: Logger;
  readonly entries: LogEntry[];
}

export interface CreateRecordingLoggerFunction {
  (): RecordingLogger;
}

/**
 * A logger that keeps every line, for tests that assert on what the kernel reports.
 */
export const createRecordingLogger: CreateRecordingLoggerFunction = () => {
  const entries: LogEntry[] = [];
  const record =
    (level: LogEntry["level"]) =>
    (message: string, fields?: LogFields): void => {
      entries.push(fields === undefined ? { level, message } : { level, message, fields });
    };
  return {
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
    entries,
  };
};

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
  /**
   * What the pipeline logs to; silent by default.
   */
  readonly logger?: Logger;
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
  logger = silentLogger,
} = {}) => {
  sentMessages.length = 0;
  placeOrderKeys.length = 0;
  const adapter = memory();
  const storage = await adapter.createStorage({ logger: silentLogger });
  const config = resolveConfig({
    storage: adapter,
    collaborators: defaultCollaborators(registry),
    ...overrides,
  });
  const clock = createFixedClock();
  const { byAggregate } = await createCollaborators({
    registry,
    config: config.collaborators,
    env: {},
    logger: silentLogger,
    clock,
  });
  const aggregates = buildAggregates({ registry, collaborators: byAggregate });
  const pipeline = createCommandPipeline({
    aggregates,
    eventStore: storage.eventStore,
    scheduler: storage.scheduler,
    config,
    ids: createSequentialIdGenerator(),
    clock,
    logger,
  });
  return { storage, config, aggregates, clock, pipeline };
};

export interface EventuallyFunction {
  <T>(assertion: () => T | Promise<T>): Promise<T>;
}

/**
 * Retries `assertion` until it passes. For conditions that background work makes true without any
 * time passing on the clock, so they hold within microseconds once the work has run.
 */
export const eventually: EventuallyFunction = (assertion) =>
  vi.waitFor(assertion, { interval: 1, timeout: 5_000 });

export interface DrainedFunction {
  (): Promise<void>;
}

/**
 * Resolves after every microtask queued so far has run, and the I/O callbacks due with them.
 */
export const drained: DrainedFunction = () => new Promise((resolve) => setImmediate(resolve));

export interface AdvanceUntilWaitingFunction {
  (clock: FixedClock, milliseconds: number): Promise<void>;
}

/**
 * Moves the clock forward, then waits until the background loops that were waiting on it are
 * waiting again: whatever the move woke up has run its pass and re-armed.
 */
export const advanceUntilWaiting: AdvanceUntilWaitingFunction = async (clock, milliseconds) => {
  const waiting = clock.pending();
  clock.advance(milliseconds);
  await eventually(() => expect(clock.pending()).toBe(waiting));
};

/**
 * What a process `config` of the order aggregate receives in kernel tests: the order events by
 * qualified name, `events.order.OrderPlaced`.
 */
export interface OrderProcessConfigArgs<Names extends string> {
  readonly events: { readonly order: { readonly [Name in Names]: `order.${Name}` } };
}

export interface BrokenCommit {
  readonly broke: () => boolean;
}

export interface BreakNextCommitFunction {
  (storage: StoragePorts): BrokenCommit;
}

/**
 * Breaks the next commit that goes through `transact`: the work runs, then the transaction fails
 * the way a lost connection or a crash would, so nothing it staged is written.
 */
export const breakNextCommit: BreakNextCommitFunction = (storage) => {
  const transact = storage.transact.bind(storage);
  let broken = false;
  storage.transact = (work) =>
    transact(async (tx) => {
      const result = await work(tx);
      if (!broken) {
        broken = true;
        throw new Error("connection lost");
      }
      return result;
    });
  return { broke: () => broken };
};
