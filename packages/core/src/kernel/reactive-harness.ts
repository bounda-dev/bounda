import type { StoragePorts } from "../adapter/adapter.ts";
import { resolveConfig } from "../config/schema.ts";
import type { Config, ResolvedConfig } from "../config/types.ts";
import { createFixedClock, type FixedClock } from "../contracts/clock.ts";
import { createSequentialIdGenerator } from "../contracts/ids.ts";
import { silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import type { Registry } from "../modules/registry.ts";
import { buildAggregates } from "./aggregate/build-aggregates.ts";
import type { AggregatesRuntime } from "./aggregate/runtime.ts";
import { createCommandPipeline } from "./command/pipeline.ts";
import { createDispatcher, type Dispatcher } from "./dispatch/dispatcher.ts";
import { buildPolicies } from "./policy/build-policies.ts";
import { createPolicySubscriber } from "./policy/runner.ts";
import { createProjectionSubscriber } from "./projection/runner.ts";
import { buildReadModels, type ReadModelsRuntime } from "./read-model/build-read-models.ts";

export interface ReactiveHarness {
  readonly storage: StoragePorts;
  readonly config: ResolvedConfig;
  readonly aggregates: AggregatesRuntime;
  readonly readModels: ReadModelsRuntime;
  readonly pipeline: ReturnType<typeof createCommandPipeline>;
  readonly clock: FixedClock;
  /**
   * Creates another dispatcher over the same storage, to simulate a second instance.
   */
  createDispatcher(): Dispatcher;
  readonly dispatcher: Dispatcher;
}

export interface CreateReactiveHarnessArgs {
  readonly registry: Registry;
  readonly config?: Partial<Omit<Config, "storage">>;
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
}) => {
  const adapter = memory();
  const storage = await adapter.createStorage({ logger: silentLogger });
  const config = resolveConfig({
    storage: adapter,
    commands: { placeOrder: { notifier: { use: "memory" } } },
    ...overrides,
  });
  const ids = createSequentialIdGenerator();
  const clock = createFixedClock();
  const aggregates = buildAggregates({ registry, config });
  const readModels = await buildReadModels({ registry, config, logger: silentLogger });
  const pipeline = createCommandPipeline({
    aggregates,
    eventStore: storage.eventStore,
    scheduler: storage.scheduler,
    config,
    ids,
    clock,
    logger: silentLogger,
  });
  const policies = buildPolicies({ registry });
  const makeDispatcher = (): Dispatcher =>
    createDispatcher({
      eventStore: storage.eventStore,
      checkpointStore: storage.checkpointStore,
      subscribers: [
        ...Object.values(readModels.byName).map((readModel) =>
          createProjectionSubscriber({ readModel, logger: silentLogger }),
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
          logger: silentLogger,
        }),
      ],
      batchSize: config.runtime.dispatcher.batchSize,
      pollIntervalMs: config.runtime.dispatcher.pollIntervalMs,
      logger: silentLogger,
    });
  return {
    storage,
    config,
    aggregates,
    readModels,
    pipeline,
    clock,
    createDispatcher: makeDispatcher,
    dispatcher: makeDispatcher(),
  };
};
