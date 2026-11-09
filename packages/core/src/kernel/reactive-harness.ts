import type { Adapter } from "../adapter/adapter.ts";
import { resolveConfig } from "../config/schema.ts";
import type { Config, ResolvedConfig } from "../config/types.ts";
import { createFixedClock, type FixedClock } from "../contracts/clock.ts";
import { createSequentialIdGenerator, type IdGenerator } from "../contracts/ids.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import type { Registry } from "../modules/registry.ts";
import { buildAggregates } from "./aggregate/build-aggregates.ts";
import { createAggregateLoader } from "./aggregate/load-aggregate.ts";
import type { AggregatesRuntime } from "./aggregate/runtime.ts";
import { createCommandPipeline } from "./command/pipeline.ts";
import { createRestrictedRetries } from "./dead-letters/restricted.ts";
import { createDeadLetterRetry, type DeadLetterRetry } from "./dead-letters/retry.ts";
import { createDispatcher, type Dispatcher } from "./dispatch/dispatcher.ts";
import type { AppStorage } from "./events/app-event-store.ts";
import { buildPersonalCategories } from "./personal-data/categories.ts";
import { buildPolicies, type PoliciesRuntime } from "./policy/build-policies.ts";
import { createDelayedPolicies } from "./policy/delayed.ts";
import { createPolicyExecutor, type PolicyExecutor } from "./policy/executor.ts";
import { createPolicySubscriber, POLICIES_SUBSCRIBER } from "./policy/runner.ts";
import { createPorts } from "./ports/ports.ts";
import { buildProcesses } from "./process/build-processes.ts";
import { createProcessRunner, PROCESSES_SUBSCRIBER, type ProcessRunner } from "./process/runner.ts";
import { createProjectionSubscriber } from "./projection/runner.ts";
import { buildReadModels, type ReadModelsRuntime } from "./read-model/build-read-models.ts";
import { createScheduledCommandWorker, type ScheduledCommandWorker } from "./scheduler/worker.ts";
import { ignoredRetries } from "./shared/pending-retries.ts";
import { defaultPorts, withPersonalKeys } from "./test-support.ts";

export interface ReactiveHarness {
  readonly storage: AppStorage;
  readonly config: ResolvedConfig;
  readonly aggregates: AggregatesRuntime;
  readonly readModels: ReadModelsRuntime;
  readonly pipeline: ReturnType<typeof createCommandPipeline>;
  readonly policies: PoliciesRuntime;
  readonly policyExecutor: PolicyExecutor;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly clock: FixedClock;
  /**
   * Creates another dispatcher over the same storage, to simulate a second instance.
   */
  createDispatcher(): Dispatcher;
  readonly dispatcher: Dispatcher;
  readonly processes: ProcessRunner;
  readonly retries: DeadLetterRetry;
  readonly worker: ScheduledCommandWorker;
}

export interface CreateReactiveHarnessArgs {
  readonly registry: Registry;
  readonly config?: Partial<Omit<Config, "storage">>;
  readonly logger?: Logger;
  /**
   * The storage to run on; the in-memory adapter unless given.
   */
  readonly adapter?: Adapter;
}

export interface CreateReactiveHarnessFunction {
  (args: CreateReactiveHarnessArgs): Promise<ReactiveHarness>;
}

/**
 * Wires the write side, projections, policies, processes and the scheduled-command worker of a
 * registry on the in-memory adapter with deterministic ids and clock. For kernel tests.
 */
export const createReactiveHarness: CreateReactiveHarnessFunction = async ({
  registry,
  config: overrides = {},
  logger = silentLogger,
  adapter = memory(),
}) => {
  const clock = createFixedClock();
  const storage = withPersonalKeys(await adapter.createStorage(), clock);
  const config = resolveConfig({
    storage: adapter,
    ports: defaultPorts(registry),
    ...overrides,
  });
  const ids = createSequentialIdGenerator();
  const { byAggregate } = await createPorts({
    registry,
    config: config.ports,
    env: {},
    logger,
    clock,
  });
  const aggregates = buildAggregates({ registry, ports: byAggregate, config });
  const loader = createAggregateLoader({
    snapshotStore: storage.snapshotStore,
    logger,
    strict: true,
  });
  const readModels = await buildReadModels({ registry, config, logger });
  const pipeline = createCommandPipeline({
    aggregates,
    loader,
    storage,
    config,
    ids,
    clock,
    logger,
  });
  const policies = buildPolicies({ registry, aggregates });
  const personalCategories = buildPersonalCategories({
    module: registry.personalData,
    retention: config.runtime.personalData.retention,
  });
  const policyExecutor = createPolicyExecutor({
    aggregates,
    pipeline,
    config,
    personalCategories,
    ids,
    clock,
    logger,
  });
  const processes = createProcessRunner({
    processes: buildProcesses({ registry, aggregates, config }),
    aggregates,
    pipeline,
    storage,
    config,
    personalCategories,
    ids,
    clock,
    pendingRetries: ignoredRetries,
    logger,
  });
  const retries = createDeadLetterRetry({
    storage,
    pipeline,
    aggregates,
    policies,
    policyExecutor,
    processes,
    config,
    ids,
    clock,
  });
  const worker = createScheduledCommandWorker({
    storage,
    aggregates,
    pipeline,
    processes,
    delayedPolicies: createDelayedPolicies({
      policies,
      executor: policyExecutor,
      eventStore: storage.eventStore,
      config,
    }),
    restrictedRetries: createRestrictedRetries({ storage, retries, clock, logger }),
    reactive: [POLICIES_SUBSCRIBER, PROCESSES_SUBSCRIBER],
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
            errorText: config.runtime.telemetry.errorText,
            budget: { clock, maxMs: config.runtime.dispatcher.projectionBatchTimeMs },
          }),
        ),
        createPolicySubscriber({
          policies,
          aggregates,
          executor: policyExecutor,
          storage,
          config,
          clock,
          pendingRetries: ignoredRetries,
          logger,
        }),
        processes,
      ],
      batchSize: config.runtime.dispatcher.batchSize,
      pollIntervalMs: config.runtime.dispatcher.pollIntervalMs,
      backoff: config.runtime.dispatcher.backoff,
      clock,
      logger,
      errorText: config.runtime.telemetry.errorText,
    });
  return {
    storage,
    config,
    aggregates,
    readModels,
    pipeline,
    policies,
    policyExecutor,
    ids,
    logger,
    clock,
    createDispatcher: makeDispatcher,
    dispatcher: makeDispatcher(),
    processes,
    retries,
    worker,
  };
};
