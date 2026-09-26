import type { StoragePorts } from "../adapter/adapter.ts";
import { resolveConfig } from "../config/schema.ts";
import type { Config, ResolvedConfig } from "../config/types.ts";
import { createFixedClock, type FixedClock } from "../contracts/clock.ts";
import { createSequentialIdGenerator, type IdGenerator } from "../contracts/ids.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import type { Registry } from "../modules/registry.ts";
import { buildAggregates } from "./aggregate/build-aggregates.ts";
import type { AggregatesRuntime } from "./aggregate/runtime.ts";
import { createCommandPipeline } from "./command/pipeline.ts";
import { createDispatcher, type Dispatcher } from "./dispatch/dispatcher.ts";
import { buildPolicies, type PoliciesRuntime } from "./policy/build-policies.ts";
import { createPolicySubscriber } from "./policy/runner.ts";
import { buildProcesses } from "./process/build-processes.ts";
import { createProcessRunner, type ProcessRunner } from "./process/runner.ts";
import { createProjectionSubscriber } from "./projection/runner.ts";
import { buildReadModels, type ReadModelsRuntime } from "./read-model/build-read-models.ts";
import { createScheduledCommandWorker, type ScheduledCommandWorker } from "./scheduler/worker.ts";

export interface ReactiveHarness {
  readonly storage: StoragePorts;
  readonly config: ResolvedConfig;
  readonly aggregates: AggregatesRuntime;
  readonly readModels: ReadModelsRuntime;
  readonly pipeline: ReturnType<typeof createCommandPipeline>;
  readonly policies: PoliciesRuntime;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly clock: FixedClock;
  /**
   * Creates another dispatcher over the same storage, to simulate a second instance.
   */
  createDispatcher(): Dispatcher;
  readonly dispatcher: Dispatcher;
  readonly processes: ProcessRunner;
  readonly worker: ScheduledCommandWorker;
}

export interface CreateReactiveHarnessArgs {
  readonly registry: Registry;
  readonly config?: Partial<Omit<Config, "storage">>;
  readonly logger?: Logger;
}

export interface CreateReactiveHarnessFunction {
  (args: CreateReactiveHarnessArgs): Promise<ReactiveHarness>;
}

/**
 * Wires the write side, projections and policies of a registry on the in-memory adapter with
 * deterministic ids and clock. For kernel tests.
 */
export const createReactiveHarness: CreateReactiveHarnessFunction = async ({
  registry,
  config: overrides = {},
  logger = silentLogger,
}) => {
  const adapter = memory();
  const storage = await adapter.createStorage({ logger });
  const config = resolveConfig({
    storage: adapter,
    commands: { placeOrder: { notifier: { use: "memory" } } },
    ...overrides,
  });
  const ids = createSequentialIdGenerator();
  const clock = createFixedClock();
  const aggregates = buildAggregates({ registry, config });
  const readModels = await buildReadModels({ registry, config, logger });
  const pipeline = createCommandPipeline({
    aggregates,
    eventStore: storage.eventStore,
    scheduler: storage.scheduler,
    config,
    ids,
    clock,
    logger,
  });
  const policies = buildPolicies({ registry, config });
  const processes = createProcessRunner({
    processes: buildProcesses({ registry, config }),
    aggregates,
    pipeline,
    storage,
    config,
    ids,
    clock,
    logger,
  });
  const worker = createScheduledCommandWorker({
    storage,
    aggregates,
    pipeline,
    processes,
    config,
    ids,
    clock,
    logger,
  });
  const makeDispatcher = (): Dispatcher =>
    createDispatcher({
      eventStore: storage.eventStore,
      checkpointStore: storage.checkpointStore,
      subscribers: [
        ...Object.values(readModels.byName).map((readModel) =>
          createProjectionSubscriber({
            readModel,
            logger,
            budget: { clock, maxMs: config.runtime.dispatcher.projectionBatchTimeMs },
          }),
        ),
        createPolicySubscriber({
          policies,
          aggregates,
          pipeline,
          ledger: storage.inboxLedger,
          deadLetters: storage.deadLetterStore,
          config,
          ids,
          clock,
          logger,
        }),
        processes,
      ],
      batchSize: config.runtime.dispatcher.batchSize,
      pollIntervalMs: config.runtime.dispatcher.pollIntervalMs,
      backoff: config.runtime.dispatcher.backoff,
      clock,
      logger,
    });
  return {
    storage,
    config,
    aggregates,
    readModels,
    pipeline,
    policies,
    ids,
    logger,
    clock,
    createDispatcher: makeDispatcher,
    dispatcher: makeDispatcher(),
    processes,
    worker,
  };
};
