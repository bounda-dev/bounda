import type { ObservableResult } from "@opentelemetry/api";
import { isAdapter } from "../adapter/adapter.ts";
import { resolveConfig } from "../config/schema.ts";
import type { Config, ResolvedConfig, RuntimeRole } from "../config/types.ts";
import { type Clock, systemClock } from "../contracts/clock.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import { type IdGenerator, uuidV7IdGenerator } from "../contracts/ids.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import type { CommandsFacade, QueriesFacade, Registry } from "../modules/registry.ts";
import { validateRegistry } from "../modules/validate.ts";
import type { AppRegistry } from "../register/index.ts";
import { buildAggregates } from "./aggregate/build-aggregates.ts";
import { withUpcasting } from "./aggregate/upcasting.ts";
import { createCommandsFacade } from "./command/facade.ts";
import { createCommandPipeline } from "./command/pipeline.ts";
import { createDeadLetters, type DeadLetters } from "./dead-letters/dead-letters.ts";
import { createDispatcher, type DispatcherLag } from "./dispatch/dispatcher.ts";
import { buildPolicies } from "./policy/build-policies.ts";
import { createPolicySubscriber } from "./policy/runner.ts";
import { buildProcesses } from "./process/build-processes.ts";
import { createProcessRunner } from "./process/runner.ts";
import { createProjectionSubscriber } from "./projection/runner.ts";
import { buildQueries } from "./query/build-queries.ts";
import { createQueryRunner } from "./query/runner.ts";
import { buildReadModels } from "./read-model/build-read-models.ts";
import { type RebuildReadModelResult, rebuildReadModel } from "./read-model/rebuild.ts";
import { createScheduledCommandWorker } from "./scheduler/worker.ts";
import { ATTRIBUTES, METRICS, meter } from "./telemetry.ts";

/**
 * A running Bounda application.
 */
export interface BoundaApp<R extends Registry = AppRegistry> {
  readonly commands: CommandsFacade<R>;
  readonly queries: QueriesFacade<R>;
  readonly config: ResolvedConfig;
  readonly role: RuntimeRole;
  /**
   * Starts background work: the dispatcher and the scheduled command worker. Does nothing for
   * `role: "web"`.
   */
  start(): void;
  /**
   * Stops background work, waits for passes in flight and closes every storage connection.
   */
  stop(): Promise<void>;
  /**
   * Runs dispatcher passes and due scheduled commands until nothing moves. What tests await after
   * dispatching commands. Works in every role.
   */
  processUntilIdle(): Promise<void>;
  /**
   * Runs the projections until every read model reflects the events stored so far. Policies,
   * processes and scheduled commands are left to the background. Works in every role.
   */
  catchUpReadModels(): Promise<void>;
  /**
   * Rebuilds one read model from the whole stream into a fresh table and swaps it in, without
   * taking it offline. See `rebuildReadModel`.
   */
  rebuildReadModel(name: string): Promise<RebuildReadModelResult>;
  /**
   * The handler runs that gave up, and what to do about them: list, replay or discard.
   */
  readonly deadLetters: DeadLetters;
  getLag(): Promise<DispatcherLag>;
}

export interface CreateAppArgs<R extends Registry> {
  readonly registry: R;
  readonly config: Config;
  readonly logger?: Logger;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
}

export interface CreateAppFunction {
  <R extends Registry>(args: CreateAppArgs<R>): Promise<BoundaApp<R>>;
}

/**
 * Wires a Bounda application from its registry and configuration. Nothing here touches the file
 * system or Node APIs; `@bounda-dev/core/node` adds `boot()` for that. Storage is opened here, so
 * call `stop()` when done.
 */
export const createApp: CreateAppFunction = async <R extends Registry>({
  registry,
  config: rawConfig,
  logger = silentLogger,
  ids = uuidV7IdGenerator,
  clock = systemClock,
}: CreateAppArgs<R>): Promise<BoundaApp<R>> => {
  validateRegistry(registry);
  const config = resolveConfig(rawConfig);
  if (!isAdapter(config.storage)) {
    throw new ConfigurationError(
      `storage "${config.storage.name}" is a definition without factories. Import the adapter package's factory.`,
    );
  }
  const opened = await config.storage.createStorage({ logger });
  const aggregates = buildAggregates({ registry, config });
  const storage = {
    ...opened,
    eventStore: withUpcasting({ eventStore: opened.eventStore, aggregates }),
  };
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
  const queryRunner = createQueryRunner({ queries: buildQueries({ readModels }), readModels });
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
  const policies = buildPolicies({ registry });
  const dispatcher = createDispatcher({
    eventStore: storage.eventStore,
    checkpointStore: storage.checkpointStore,
    subscribers: [
      ...Object.values(readModels.byName).map((readModel) =>
        createProjectionSubscriber({ readModel, logger }),
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
  const deadLetters = createDeadLetters({
    storage,
    aggregates,
    pipeline,
    policies,
    processes,
    config,
    ids,
    clock,
    logger,
  });
  const lag = meter().createObservableGauge(METRICS.lag, {
    description: "Events each subscriber is behind the head of the stream",
    unit: "{event}",
  });
  const observeLag = async (observer: ObservableResult): Promise<void> => {
    const current = await dispatcher.getLag();
    for (const subscriber of current.subscribers) {
      observer.observe(subscriber.lag, { [ATTRIBUTES.subscriber]: subscriber.subscriber });
    }
  };
  lag.addCallback(observeLag);
  const role = config.runtime.role;
  let stopped = false;

  logger.info("bounda app created", {
    role,
    aggregates: Object.keys(aggregates.byName),
    readModels: Object.keys(readModels.byName),
  });

  return {
    commands: createCommandsFacade({ aggregates, pipeline }) as CommandsFacade<R>,
    queries: queryRunner.facade as QueriesFacade<R>,
    config,
    role,
    start: () => {
      if (role === "web" || stopped) return;
      dispatcher.start();
      worker.start();
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      lag.removeCallback(observeLag);
      await Promise.all([dispatcher.stop(), worker.stop()]);
      await readModels.close();
      await storage.close();
    },
    processUntilIdle: async () => {
      for (;;) {
        const advanced = await dispatcher.processOnce();
        const ran = await worker.runOnce();
        if (!advanced && ran === 0) return;
      }
    },
    catchUpReadModels: () => dispatcher.catchUp("projection"),
    rebuildReadModel: (name) => rebuildReadModel({ registry, config: rawConfig, name, logger }),
    deadLetters,
    getLag: () => dispatcher.getLag(),
  };
};
