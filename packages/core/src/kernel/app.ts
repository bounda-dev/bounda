import type { ObservableResult } from "@opentelemetry/api";
import { isAdapter } from "../adapter/adapter.ts";
import { checkConfigNames } from "../config/names.ts";
import { resolveConfig } from "../config/schema.ts";
import type { Config, ResolvedConfig, RuntimeRole } from "../config/types.ts";
import { type Clock, systemClock } from "../contracts/clock.ts";
import type { CommandRejection, DispatchResult } from "../contracts/command.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import { type IdGenerator, uuidV7IdGenerator } from "../contracts/ids.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import type { CommandsFacade, QueriesFacade, Registry } from "../modules/registry.ts";
import { validateRegistry } from "../modules/validate.ts";
import type { AppEnv, AppRegistry, EnvSection } from "../register/index.ts";
import { buildAggregates } from "./aggregate/build-aggregates.ts";
import { withUpcasting } from "./aggregate/upcasting.ts";
import { createCommandsFacade } from "./command/facade.ts";
import { createCommandPipeline } from "./command/pipeline.ts";
import { createDeadLetters, type DeadLetters } from "./dead-letters/dead-letters.ts";
import { createDispatcher, type DispatcherLag } from "./dispatch/dispatcher.ts";
import { alignReactiveCheckpoints } from "./dispatch/reactive-checkpoints.ts";
import { buildPolicies } from "./policy/build-policies.ts";
import { createDelayedPolicies } from "./policy/delayed.ts";
import { createPolicyExecutor } from "./policy/executor.ts";
import { createPolicySubscriber } from "./policy/runner.ts";
import { createPorts, type TestChoice } from "./ports/ports.ts";
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
import { guardedLogger } from "./shared/guarded-logger.ts";
import { ignoredRetries, type PendingRetries } from "./shared/pending-retries.ts";
import { ATTRIBUTES, METRICS, meter } from "./telemetry.ts";

/**
 * What `catchUpReadModels` waits for: every read model when empty, or only what one dispatch
 * changed when `through` holds its result.
 */
export interface CatchUpReadModelsArgs {
  readonly through?: DispatchResult;
}

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
   * Stops background work, waits for passes in flight and closes every storage connection, then
   * every implementation a `create` export built that has `[Symbol.asyncDispose]`, last built first;
   * one that fails to close is logged and the rest still close. Every call, including one made
   * while a stop is under way, waits for that same stop.
   */
  stop(): Promise<void>;
  /**
   * Runs dispatcher passes and due scheduled commands until nothing moves, or until `maxPasses`
   * rounds when given, and says whether it got there. A retry waiting for its back-off is left
   * for later, except in an app from `createTestApp`, which moves its clock to it, running what
   * falls due on the way, and counts that move as a round; there, nothing else may run on the app
   * meanwhile, since moving the clock also runs out the time of a handler still running. What
   * tests await after dispatching commands, and what a host without a background loop, such as a
   * Durable Object alarm, runs in bounded slices. Works in every role.
   */
  runUntilIdle(options?: RunUntilIdleOptions): Promise<RunUntilIdleResult>;
  /**
   * The earliest moment a scheduled command or a process deadline becomes due, or `null` when
   * nothing is scheduled. A host without a polling worker arms its wake-up for it.
   */
  nextDueAt(): Promise<Date | null>;
  /**
   * Runs the projections until every read model reflects the events stored so far. With `through`,
   * only waits for the read models that project the events of that dispatch, until they reach its
   * position, for at most `runtime.dispatcher.catchUp.timeout`: what a request that reads its own
   * writes needs, and it then never rejects: a read model it cannot read is logged and left
   * behind. Policies, processes and scheduled commands are left to the background. Works in every
   * role.
   */
  catchUpReadModels(args?: CatchUpReadModelsArgs): Promise<void>;
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
   * The handler runs that gave up, and what to do about them: list, retry or discard.
   */
  readonly deadLetters: DeadLetters;
  getLag(): Promise<AppLag>;
}

/**
 * How far behind the background work is: every subscriber's lag, and how many process deadlines
 * that came due this process holds back until the process runner catches up.
 */
export interface AppLag extends DispatcherLag {
  readonly waitingDeadlines: number;
}

export interface RebuildReadModelOptions {
  /**
   * Project at most about this many events, then pause until the next call.
   */
  readonly maxEvents?: number;
}

export interface RunUntilIdleOptions {
  /**
   * At most this many rounds of one dispatcher pass plus one run of due scheduled commands; in an
   * app from `createTestApp`, a round that moves the clock to a retry counts too. Unbounded when
   * omitted.
   */
  readonly maxPasses?: number;
}

export interface RunUntilIdleResult {
  /**
   * `true` when a round moved nothing: nothing is due, and every subscriber is caught up but for
   * events whose retry waits for its back-off, which an app from `createTestApp` has run too.
   * `false` when `maxPasses` ran out with work left.
   */
  readonly idle: boolean;
  /**
   * The rejections of the commands that policies, processes, the scheduler and dead-letter
   * retries dispatched while it ran, those of the background loop `start()` runs included, in
   * order, so a test can assert the ones it expects. A run that is retried counts them only from
   * the attempt that commits.
   */
  readonly rejections: readonly CommandRejection[];
}

/**
 * `env` is the host's environment, which every port implementation's `create` receives;
 * `EnvSection` says when it is required.
 */
export type CreateAppArgs<R extends Registry> = {
  readonly registry: R;
  readonly config: Config;
  /**
   * Defaults to `silentLogger`.
   */
  readonly logger?: Logger;
  /**
   * Defaults to UUID v7 ids.
   */
  readonly ids?: IdGenerator;
  /**
   * Defaults to `systemClock`.
   */
  readonly clock?: Clock;
} & EnvSection<R>;

export interface CreateAppFunction {
  <R extends Registry>(args: CreateAppArgs<R>): Promise<BoundaApp<R>>;
}

/**
 * Wires a Bounda application from its registry and configuration. Nothing here touches the file
 * system or Node APIs; `@bounda-dev/core/node` adds `boot()` for that. Storage is opened and the
 * ports' `create` exports run here, so call `stop()` when done.
 */
export const createApp: CreateAppFunction = <R extends Registry>({
  registry,
  config,
  logger = silentLogger,
  ids = uuidV7IdGenerator,
  clock = systemClock,
  env = {},
}: CreateAppArgs<R>): Promise<BoundaApp<R>> =>
  assembleApp<R>({ registry, config, logger, ids, clock, env });

export interface AssembleAppArgs<R extends Registry> {
  readonly registry: R;
  readonly config: Config;
  readonly logger: Logger;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly env: AppEnv;
  /**
   * Given by `createTestApp`: the ports come from the test instead of `config.ports`.
   */
  readonly test?: TestChoice;
  /**
   * Given by `createTestApp`, whose `runUntilIdle` moves its clock to the retries waiting.
   */
  readonly pendingRetries?: PendingRetries;
}

export interface AssembleAppFunction {
  <R extends Registry>(args: AssembleAppArgs<R>): Promise<BoundaApp<R>>;
}

export const assembleApp: AssembleAppFunction = async <R extends Registry>({
  registry,
  config: rawConfig,
  logger: rawLogger,
  ids,
  clock,
  env,
  test,
  pendingRetries = ignoredRetries,
}: AssembleAppArgs<R>): Promise<BoundaApp<R>> => {
  validateRegistry(registry);
  const config = resolveConfig(rawConfig);
  checkConfigNames({ registry, config });
  const logger = guardedLogger(rawLogger);
  if (!isAdapter(config.storage)) {
    throw new ConfigurationError(
      `storage "${config.storage.name}" is a definition without factories. Import the adapter package's factory.`,
    );
  }
  // Built before the storage opens and closed after it, so a `create` that fails leaves nothing
  // open; a failure further on closes them again.
  const ports = await createPorts({
    registry,
    env,
    logger,
    clock,
    ...(test === undefined ? { config: config.ports } : { test }),
  });
  // What a start that fails has to close, in the order `stop` closes it.
  const opened: (() => Promise<void>)[] = [];
  try {
    const written = await config.storage.createStorage({ logger });
    opened.unshift(() => written.close());
    const aggregates = buildAggregates({ registry, ports: ports.byAggregate });
    const storage = {
      ...written,
      eventStore: withUpcasting({ eventStore: written.eventStore, aggregates }),
    };
    const readModels = await buildReadModels({ registry, config, logger });
    opened.unshift(() => readModels.close());
    // One list per `runUntilIdle` under way.
    const observers = new Set<CommandRejection[]>();
    const pipeline = createCommandPipeline({
      aggregates,
      eventStore: storage.eventStore,
      scheduler: storage.scheduler,
      config,
      ids,
      clock,
      logger,
      onRejection: (rejection) => {
        for (const observed of observers) observed.push(rejection);
      },
    });
    const queryRunner = createQueryRunner({
      queries: buildQueries({ readModels }),
      readModels,
      ports: ports.byReadModel,
    });
    const processDefinitions = buildProcesses({ registry, aggregates, config });
    const processes = createProcessRunner({
      processes: processDefinitions,
      aggregates,
      pipeline,
      storage,
      config,
      ids,
      clock,
      pendingRetries,
      logger,
    });
    const policies = buildPolicies({ registry, aggregates });
    const policyExecutor = createPolicyExecutor({ aggregates, pipeline, config, clock, logger });
    const reactive = [
      {
        subscriber: createPolicySubscriber({
          policies,
          executor: policyExecutor,
          storage,
          config,
          clock,
          pendingRetries,
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
    });
    const dispatcher = createDispatcher({
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
        ...following,
      ],
      batchSize: config.runtime.dispatcher.batchSize,
      pollIntervalMs: config.runtime.dispatcher.pollIntervalMs,
      backoff: config.runtime.dispatcher.backoff,
      catchUp: config.runtime.dispatcher.catchUp,
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
      delayedPolicies: createDelayedPolicies({
        policies,
        executor: policyExecutor,
        eventStore: storage.eventStore,
        config,
      }),
      config,
      ids,
      clock,
      logger,
    });
    const deadLetters = createDeadLetters({
      storage,
      pipeline,
      aggregates,
      policies,
      policyExecutor,
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
    const nextDueAt = (): Promise<Date | null> =>
      storage.scheduler.nextDueAt({ leaseMs: worker.leaseMs });
    // A scheduled command that failed waits for its retry with its attempts counted; scheduling it
    // anew counts them from zero, so a retry that no longer waits is not taken for one.
    const nextRetryAt = async (): Promise<Date | null> => {
      const now = clock.now().getTime();
      const times = (await storage.scheduler.list())
        .filter((entry) => entry.attempts > 0)
        .map((entry) => Date.parse(entry.executeAt))
        .filter((at) => at > now);
      return times.length === 0 ? null : new Date(Math.min(...times));
    };
    let stopping: Promise<void> | undefined;

    logger.info("bounda app created", {
      role,
      aggregates: Object.keys(aggregates.byName),
      readModels: Object.keys(readModels.byName),
    });

    return {
      commands: createCommandsFacade({
        aggregates,
        dispatch: (command) => pipeline.dispatch(command),
      }) as CommandsFacade<R>,
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
          try {
            lag.removeCallback(observeLag);
            await Promise.all([dispatcher.stop(), worker.stop()]);
            try {
              await readModels.close();
            } finally {
              await storage.close();
            }
          } finally {
            await ports.dispose();
          }
        })();
        return stopping;
      },
      runUntilIdle: async ({ maxPasses = Number.POSITIVE_INFINITY } = {}) => {
        const rejections: CommandRejection[] = [];
        observers.add(rejections);
        try {
          for (let round = 0; round < maxPasses; round += 1) {
            pendingRetries.startRound();
            const advanced = await dispatcher.processOnce();
            const ran = await worker.runOnce();
            if (advanced || ran > 0) continue;
            if (!(await pendingRetries.skipToNext(nextDueAt, nextRetryAt))) {
              return { idle: true, rejections };
            }
          }
          return { idle: false, rejections };
        } finally {
          observers.delete(rejections);
        }
      },
      nextDueAt,
      catchUpReadModels: async ({ through } = {}) => {
        if (through === undefined) return dispatcher.catchUp("projection");
        if (through.scheduled) return;
        await dispatcher.catchUpThrough(through);
      },
      rebuildReadModel: (name, { maxEvents } = {}) =>
        rebuildReadModel({
          registry,
          config: rawConfig,
          name,
          logger,
          ...(maxEvents === undefined ? {} : { maxEvents }),
        }),
      pendingRebuilds: async () => {
        const paused = await Promise.all(
          Object.values(readModels.byName).map(async ({ name, storage }) =>
            (await pendingRebuilds(storage.checkpointStore)).includes(name) ? [name] : [],
          ),
        );
        return paused.flat();
      },
      deadLetters,
      getLag: async () => ({
        ...(await dispatcher.getLag()),
        waitingDeadlines: worker.waitingDeadlines(),
      }),
    };
  } catch (error) {
    for (const close of opened) await close().catch(() => undefined);
    await ports.dispose();
    throw error;
  }
};
