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
import { alignReactiveCheckpoints } from "./dispatch/reactive-checkpoints.ts";
import { buildPolicies } from "./policy/build-policies.ts";
import { createPolicySubscriber } from "./policy/runner.ts";
import { buildProcesses } from "./process/build-processes.ts";
import { createProcessRunner } from "./process/runner.ts";
import { createProjectionSubscriber } from "./projection/runner.ts";
import { buildQueries } from "./query/build-queries.ts";
import { createQueryRunner } from "./query/runner.ts";
import { buildReadModels } from "./read-model/build-read-models.ts";
import {
  pendingRebuilds,
  type RebuildReadModelResult,
  rebuildReadModel,
} from "./read-model/rebuild.ts";
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
   * Stops background work, waits for passes in flight and closes every storage connection. Every
   * call, including one made while a stop is under way, waits for that same stop.
   */
  stop(): Promise<void>;
  /**
   * Runs dispatcher passes and due scheduled commands until nothing moves, or until `maxPasses`
   * rounds when given, and says whether it got there. What tests await after dispatching commands,
   * and what a host without a background loop, such as a Durable Object alarm, runs in bounded
   * slices. Works in every role.
   */
  processUntilIdle(options?: ProcessUntilIdleOptions): Promise<ProcessUntilIdleResult>;
  /**
   * The earliest moment a scheduled command or a process timeout becomes due, or `null` when
   * nothing is scheduled. A host without a polling worker arms its wake-up for it.
   */
  nextDueAt(): Promise<Date | null>;
  /**
   * Runs the projections until every read model reflects the events stored so far. Policies,
   * processes and scheduled commands are left to the background. Works in every role.
   */
  catchUpReadModels(): Promise<void>;
  /**
   * Rebuilds one read model from the whole stream into a fresh table and swaps it in, without
   * taking it offline, or, with `maxEvents`, advances it by one slice and pauses. See
   * `rebuildReadModel`.
   */
  rebuildReadModel(
    name: string,
    options?: RebuildReadModelOptions,
  ): Promise<RebuildReadModelResult>;
  /**
   * The read models of the registry whose rebuild is paused, waiting for another
   * `rebuildReadModel` call.
   */
  pendingRebuilds(): Promise<readonly string[]>;
  /**
   * The handler runs that gave up, and what to do about them: list, replay or discard.
   */
  readonly deadLetters: DeadLetters;
  getLag(): Promise<DispatcherLag>;
}

export interface RebuildReadModelOptions {
  /**
   * Project at most about this many events, then pause until the next call.
   */
  readonly maxEvents?: number;
}

export interface ProcessUntilIdleOptions {
  /**
   * At most this many rounds of one dispatcher pass plus one run of due scheduled commands.
   * Unbounded when omitted.
   */
  readonly maxPasses?: number;
}

export interface ProcessUntilIdleResult {
  /**
   * `true` when a round moved nothing: every subscriber is caught up and nothing is due. `false`
   * when `maxPasses` ran out with work left.
   */
  readonly idle: boolean;
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
  const processDefinitions = buildProcesses({ registry, config });
  const processes = createProcessRunner({
    processes: processDefinitions,
    aggregates,
    pipeline,
    storage,
    config,
    ids,
    clock,
    logger,
  });
  const policies = buildPolicies({ registry });
  const reactive = [
    {
      subscriber: createPolicySubscriber({
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
      following: policies.all.length > 0,
    },
    { subscriber: processes, following: processDefinitions.all.length > 0 },
  ];
  const following = reactive.filter((entry) => entry.following).map((entry) => entry.subscriber);
  await alignReactiveCheckpoints({
    eventStore: storage.eventStore,
    checkpointStore: storage.checkpointStore,
    following: following.map((subscriber) => subscriber.name),
    idle: reactive.filter((entry) => !entry.following).map((entry) => entry.subscriber.name),
  });
  const dispatcher = createDispatcher({
    eventStore: storage.eventStore,
    checkpointStore: storage.checkpointStore,
    subscribers: [
      ...Object.values(readModels.byName).map((readModel) =>
        createProjectionSubscriber({ readModel, logger }),
      ),
      ...following,
    ],
    batchSize: config.runtime.dispatcher.batchSize,
    pollIntervalMs: config.runtime.dispatcher.pollIntervalMs,
    idleIntervalMs: config.runtime.dispatcher.idleIntervalMs,
    ...(storage.notifier === undefined ? {} : { notifier: storage.notifier }),
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
  let stopping: Promise<void> | undefined;

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
      if (role === "web" || stopping !== undefined) return;
      dispatcher.start();
      worker.start();
    },
    stop: () => {
      stopping ??= (async () => {
        lag.removeCallback(observeLag);
        await Promise.all([dispatcher.stop(), worker.stop()]);
        await readModels.close();
        await storage.close();
      })();
      return stopping;
    },
    processUntilIdle: async ({ maxPasses = Number.POSITIVE_INFINITY } = {}) => {
      for (let round = 0; round < maxPasses; round += 1) {
        const advanced = await dispatcher.processOnce();
        const ran = await worker.runOnce();
        if (!advanced && ran === 0) return { idle: true };
      }
      return { idle: false };
    },
    nextDueAt: () => storage.scheduler.nextDueAt({ leaseMs: worker.leaseMs }),
    catchUpReadModels: () => dispatcher.catchUp("projection"),
    rebuildReadModel: (name, { maxEvents } = {}) =>
      rebuildReadModel({
        registry,
        config: rawConfig,
        name,
        logger,
        ...(maxEvents === undefined ? {} : { maxEvents }),
      }),
    pendingRebuilds: async () =>
      (await pendingRebuilds(storage.checkpointStore)).filter(
        (name) => name in registry.readModels,
      ),
    deadLetters,
    getLag: () => dispatcher.getLag(),
  };
};
