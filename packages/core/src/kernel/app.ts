import type { ObservableResult } from "@opentelemetry/api";
import { isAdapter } from "../adapter/adapter.ts";
import { checkConfigNames } from "../config/names.ts";
import { resolveConfig } from "../config/schema.ts";
import type { Config, ResolvedConfig, RuntimeRole } from "../config/types.ts";
import { type Clock, systemClock } from "../contracts/clock.ts";
import type { CommandRejection, DispatchResult, StoredDispatch } from "../contracts/command.ts";
import { ConfigurationError, ForgetLedgerUnreconciledError } from "../contracts/errors.ts";
import { type IdGenerator, uuidV7IdGenerator } from "../contracts/ids.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import { checkActor } from "../contracts/metadata.ts";
import type { OnPersonalDataAccess } from "../modules/audit.ts";
import type { CommandsFacade, QueriesFacade, Registry } from "../modules/registry.ts";
import { validateRegistry } from "../modules/validate.ts";
import type { AppEnv, AppRegistry, EnvSection } from "../register/index.ts";
import { buildAggregates } from "./aggregate/build-aggregates.ts";
import { createAggregateLoader } from "./aggregate/load-aggregate.ts";
import { checkStoredTypes, processNamesOf } from "./aggregate/stored-types.ts";
import { createCommandsFacade } from "./command/facade.ts";
import { createCommandPipeline } from "./command/pipeline.ts";
import { createDeadLetters, type DeadLetters } from "./dead-letters/dead-letters.ts";
import { createRestrictedRetries } from "./dead-letters/restricted.ts";
import { createDeadLetterRetry } from "./dead-letters/retry.ts";
import { createDispatcher, type DispatcherLag } from "./dispatch/dispatcher.ts";
import { alignReactiveCheckpoints } from "./dispatch/reactive-checkpoints.ts";
import { appStorage } from "./events/app-event-store.ts";
import { createGlobalStream, type GlobalStream } from "./events/global-stream.ts";
import { createAccessLog, recorded } from "./personal-data/access.ts";
import { exportPersonalData, type PersonalDataExport } from "./personal-data/export.ts";
import { forgetPersonalData, logForgotten } from "./personal-data/forget.ts";
import {
  FORGET_LEDGER_WAIT_MS,
  openForgetLedger,
  waitForLedger,
} from "./personal-data/forget-ledger.ts";
import { withLedgerAppend } from "./personal-data/ledger-append.ts";
import { createLedgerOutbox } from "./personal-data/ledger-outbox.ts";
import { marksPersonalFields } from "./personal-data/marks.ts";
import {
  createForgetLedgerReconciliation,
  type ForgetAgainEntry,
  forgetAgain,
} from "./personal-data/reconciliation.ts";
import { liftProcessingRestriction, restrictProcessing } from "./personal-data/restriction.ts";
import { createRetentionSubscriber, createRetentionSweep } from "./personal-data/retention.ts";
import { createKeyRotation } from "./personal-data/rotation.ts";
import { checkPersonId } from "./personal-data/transact.ts";
import { buildPersonalKeyWrapping } from "./personal-data/wrapped-keys.ts";
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
  rebuildReadModelWith,
} from "./read-model/rebuild.ts";
import { createScheduledCommandWorker } from "./scheduler/worker.ts";
import { guardedLogger } from "./shared/guarded-logger.ts";
import { ignoredRetries, type PendingRetries } from "./shared/pending-retries.ts";
import { createSnapshotSubscriber, takesSnapshots } from "./snapshot/subscriber.ts";
import { ATTRIBUTES, METRICS, meter, tracedOperation } from "./telemetry.ts";

/**
 * What `catchUpReadModels` waits for: every read model when empty, or only what one dispatch
 * changed when `through` holds its result.
 */
export interface CatchUpReadModelsArgs {
  readonly through?: DispatchResult;
}

/**
 * What a request sees of a running app, wherever the app runs: the `BoundaApp` itself, or a
 * Durable Object reached through `connect` from `@bounda-dev/cloudflare`. The `bounda`
 * context of `@bounda-dev/react-router` holds one.
 */
export interface BoundaClient<R extends Registry = AppRegistry> {
  readonly commands: CommandsFacade<R>;
  /**
   * Each query runs as the client's actor, which its `repository` and `handler` receive. A query
   * of a read model with fields marked `.personal()` is recorded in the access log, as
   * `exportPersonalData` is, naming the persons of the rows it read, whether it resolves or
   * rejects.
   */
  readonly queries: QueriesFacade<R>;
  getLag(): Promise<AppLag>;
  readonly events: GlobalStream;
  /**
   * Retrying and discarding a letter is acted by the client's actor, as `as` says. Each call but
   * `count` is recorded in the access log, as `exportPersonalData` is.
   */
  readonly deadLetters: Pick<DeadLetters, "list" | "retry" | "discard">;
  /**
   * Rebuilds one read model from the whole stream into a fresh table and swaps it in, without
   * taking it offline. A Durable Object runs the first slice and resolves with `done: false`
   * when more remain, which its alarm runs.
   */
  rebuildReadModel(name: string): Promise<RebuildReadModelResult>;
  /**
   * Forgets a person: deletes the key their personal fields are encrypted with, so every event
   * of theirs, and the state of every process instance that names them, reads those fields as
   * `null` from now on, the instance carrying on, and appends `PersonalDataForgotten` to
   * the stream `bounda:<personId>`, which every read model that projects personal fields handles.
   * Both happen together or not at all. Resolves like a command, so
   * `catchUpReadModels({ through })` waits for those read models. Rejects with
   * `ValidationError` an empty id.
   */
  forget(personId: string): Promise<StoredDispatch>;
  /**
   * Everything the store holds that names a person, for them to take away: their events, with
   * the fields marked `personal` opened (`null` each once they are forgotten) and nothing else of
   * the payload, among them the lifecycle events of the process instances whose state names them,
   * the scheduled commands that hold such fields of theirs, and the dead letters of
   * work about them, with the error text sealed under their key opened, and the rows of every read
   * model with a field marked `.person()` that name them, with their fields marked `.personal()`.
   * A field left unmarked and whatever a policy sent out are not in it. Recorded in the access log
   * before it settles, whether it resolves or fails after it started reading: `app/audit.ts`'s
   * `onPersonalDataAccess`, or the app's logger at `info` without it; rejects with what the hook
   * throws. Rejects with `ValidationError` an empty id, recording nothing.
   */
  exportPersonalData(personId: string): Promise<PersonalDataExport>;
  /**
   * Restricts the processing of a person's data: from then on every command that touches them,
   * the one their payload names with `person` or whose aggregate is the person, is refused with
   * `ProcessingRestrictedError`, and a policy, process or scheduled command whose command is
   * refused becomes a dead letter at once, with that code and the person, as does a step of a
   * process instance whose state names them, before its handler runs. Writes their row and
   * appends `ProcessingRestricted` to the stream `bounda:<personId>` together, and resolves like
   * a command, so `catchUpReadModels({ through })` waits for the read models that handle it.
   * Restricting a person restricted already appends nothing and resolves without events. Reading
   * their data, `forget` and the export stay allowed. Rejects with `ValidationError` an empty id.
   */
  restrict(personId: string): Promise<StoredDispatch>;
  /**
   * Lifts the restriction: appends `ProcessingRestrictionLifted` the same way, and the runtime
   * then retries, in the background, every dead letter the restriction caused, in order; one
   * that fails again for another reason stays, as that failure's letter. Lifting for a person
   * not restricted appends nothing and resolves without events. Rejects with `ValidationError`
   * an empty id.
   */
  unrestrict(personId: string): Promise<StoredDispatch>;
  /**
   * The same client, acting as `actor`: who does what it does, for the audit trail the event
   * store keeps. Every command it dispatches carries the actor in its metadata, and so does every
   * event that command writes, and every command and event the policies, processes and scheduled
   * commands that follow from it write; so do the events `forget`, `restrict` and `unrestrict`
   * append, and what a dead letter's `retry` writes; and every record of the access log it causes
   * names it, as do the log lines of its dead letters' `retry` and `discard` and of its
   * `rebuildReadModel`. Calling `as` on a bound client acts as the new
   * actor; a client without `as` names nobody. `actor` is an id, such as a user's or a service's,
   * never a name or an email: it is stored in the clear in events that are never deleted. Throws
   * `ValidationError` for an actor that is not a string of 1 to `MAX_ACTOR_LENGTH` characters.
   */
  as(actor: string): BoundaClient<R>;
}

/**
 * A running Bounda application.
 */
export interface BoundaApp<R extends Registry = AppRegistry> extends BoundaClient<R> {
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
   * falls due on the way, and counts that move as a round, but never to a person's retention
   * deadline, which a test reaches by moving the clock itself; there, nothing else may run on the
   * app meanwhile, since moving the clock also runs out the time of a handler still running. What
   * tests await after dispatching commands, and what a host without a background loop, such as a
   * Durable Object alarm, runs in bounded slices. Works in every role.
   */
  runUntilIdle(options?: RunUntilIdleOptions): Promise<RunUntilIdleResult>;
  /**
   * The earliest moment a scheduled command or a process deadline becomes due, a person becomes
   * due for forgetting under `runtime.personalData.retention`, a person's key waits to be
   * rewrapped under `runtime.personalData.keyWrapper`, or `runtime.personalData.forgetLedger` is
   * to be read again, after a read that failed or once a ledger that shows entries late has had
   * the time to; `null` when nothing is. A person, a key or a ledger read that failed counts
   * from the end of its wait, never from now. A host without a polling worker arms its wake-up
   * for it.
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
  /**
   * Forgets again, as `forget` does with `reason: "restored"`, each person an entry names who
   * still holds a key, unless the store holds the `PersonalDataForgotten` the entry names by
   * `eventId`: a store that holds it applied that forgetting, and a key the person holds was given
   * to them after. What `bounda forget --from` runs, for a backup restored without
   * `runtime.personalData.forgetLedger`; resolves to the ids of the persons it forgot, in order.
   * Rejects with `ValidationError` an entry without a person's id, or an `actor` that `as` would
   * refuse, before forgetting anyone.
   */
  forgetAgain(
    entries: readonly ForgetAgainEntry[],
    options?: ForgetAgainOptions,
  ): Promise<readonly string[]>;
}

/**
 * How far behind the background work is: every subscriber's lag, how many process deadlines
 * and restricted retries that came due this process holds back until the reactive runners catch
 * up, and whether the forget ledger was reconciled.
 */
export interface AppLag extends DispatcherLag {
  readonly waitingDeadlines: number;
  /**
   * `null` without `runtime.personalData.forgetLedger`. `reconciled` is `false` while the ledger
   * could not be read since the app started: a person a restored backup brought back may not be
   * forgotten again yet, and the worker keeps trying.
   */
  readonly forgetLedger: ForgetLedgerLag | null;
}

export interface ForgetLedgerLag {
  readonly reconciled: boolean;
}

export interface ForgetAgainOptions {
  /**
   * Who forgets them again, named in the metadata of each `PersonalDataForgotten` and in its log
   * line, as `as` names who acts: `forgetAgain` lives on the app, not on a client.
   */
  readonly actor?: string;
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
  /**
   * The name of the store this app serves, which every port implementation's `create` receives
   * as `tenant`. `createBoundaObject` passes the Durable Object's name; leave it out for an app
   * with one store.
   */
  readonly tenant?: string | undefined;
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
  tenant,
}: CreateAppArgs<R>): Promise<BoundaApp<R>> =>
  assembleApp<R>({ registry, config, logger, ids, clock, env, tenant });

export interface AssembleAppArgs<R extends Registry> {
  readonly registry: R;
  readonly config: Config;
  readonly logger: Logger;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly env: AppEnv;
  readonly tenant?: string | undefined;
  /**
   * Given by `createTestApp`: the ports come from the test instead of `config.ports`.
   */
  readonly test?: TestChoice;
  /**
   * Given by `createTestApp`, whose `runUntilIdle` moves its clock to the retries waiting.
   */
  readonly pendingRetries?: PendingRetries;
  /**
   * Given by `createTestApp`: with `test`, the access log goes here instead of to the registry's
   * `app/audit.ts`, and to the logger without it.
   */
  readonly onPersonalDataAccess?: OnPersonalDataAccess | undefined;
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
  tenant,
  test,
  pendingRetries = ignoredRetries,
  onPersonalDataAccess,
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
  // Built first: a master key missing from the environment fails the start before anything opens.
  const wrapping = await buildPersonalKeyWrapping({
    definition: config.runtime.personalData.keyWrapper,
    env,
    clock,
  });
  // Built before the storage opens and closed after it, so a `create` that fails leaves nothing
  // open; a failure further on closes them again.
  const ports = await createPorts({
    registry,
    env,
    tenant,
    logger,
    clock,
    ...(test === undefined ? { config: config.ports } : { test }),
  });
  // What a start that fails has to close, in the order `stop` closes it.
  const opened: (() => Promise<void>)[] = [async () => wrapping.close()];
  try {
    const adapted = await config.storage.createStorage();
    opened.unshift(() => adapted.close());
    const ledgerConfig = config.runtime.personalData.forgetLedger;
    const keepForMs = ledgerConfig?.keepForMs ?? null;
    const ledger = await openForgetLedger({
      source: ledgerConfig?.store ?? null,
      storage: config.storage,
      env,
      tenant,
      keepForMs: keepForMs ?? undefined,
    });
    if (ledger?.close !== undefined) {
      const close = ledger.close.bind(ledger);
      opened.unshift(close);
    }
    const written =
      ledger === null
        ? adapted
        : withLedgerAppend({ storage: adapted, ledger, keepForMs, clock, logger });
    const aggregates = buildAggregates({ registry, ports: ports.byAggregate, config });
    checkStoredTypes({
      types: await written.eventStore.types(),
      aggregates,
      processNames: processNamesOf(registry),
    });
    const processDefinitions = buildProcesses({ registry, aggregates, config });
    const storage = appStorage({
      storage: written,
      aggregates,
      processes: processDefinitions,
      wrapping,
    });
    if (
      wrapping.wrapper === null &&
      test === undefined &&
      marksPersonalFields({ aggregates, processes: processDefinitions })
    ) {
      logger.warn(
        "personal keys are stored unwrapped, next to the data they open: set runtime.personalData.keyWrapper",
      );
    }
    const loader = createAggregateLoader({
      snapshotStore: storage.snapshotStore,
      logger,
      strict: test !== undefined,
    });
    const readModels = await buildReadModels({ registry, config, logger });
    opened.unshift(() => readModels.close());
    // One list per `runUntilIdle` under way.
    const observers = new Set<CommandRejection[]>();
    const pipeline = createCommandPipeline({
      aggregates,
      loader,
      storage,
      config,
      ids,
      clock,
      logger,
      onRejection: (rejection) => {
        for (const observed of observers) observed.push(rejection);
      },
    });
    const recordAccess = createAccessLog({
      hook: test === undefined ? registry.audit?.onPersonalDataAccess : onPersonalDataAccess,
      env,
      tenant,
      logger,
      clock,
    });
    const queryRunner = createQueryRunner({
      queries: buildQueries({ readModels }),
      readModels,
      ports: ports.byReadModel,
      recordAccess,
    });
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
    const policyExecutor = createPolicyExecutor({
      aggregates,
      pipeline,
      config,
      ids,
      clock,
      logger,
    });
    const reactive = [
      {
        subscriber: createPolicySubscriber({
          policies,
          aggregates,
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
    const retries = createDeadLetterRetry({
      storage,
      pipeline,
      aggregates,
      policies,
      policyExecutor,
      processes,
      config,
      ids,
    });
    await alignReactiveCheckpoints({
      eventStore: storage.eventStore,
      checkpointStore: storage.checkpointStore,
      following: following.map((subscriber) => subscriber.name),
    });
    const { retentionMs } = config.runtime.personalData;
    const retention =
      retentionMs === null
        ? undefined
        : createRetentionSweep({
            storage: written,
            retentionMs,
            ids,
            clock,
            logger,
            concurrencyRetries: config.runtime.commands.concurrencyRetries,
            batchSize: config.runtime.dispatcher.batchSize,
            forgotten: wrapping.drop,
          });
    const { concurrencyRetries } = config.runtime.commands;
    const reconciliation =
      ledger === null || ledgerConfig === null
        ? undefined
        : createForgetLedgerReconciliation({
            ledger,
            storage: written,
            ids,
            clock,
            logger,
            concurrencyRetries,
            reconcileEveryMs: ledgerConfig.reconcileEveryMs,
            keepForMs,
            forgotten: wrapping.drop,
          });
    const rotation =
      wrapping.wrapper === null
        ? undefined
        : createKeyRotation({
            keys: written.personalKeys,
            checkpoints: written.checkpointStore,
            wrapper: wrapping.wrapper,
            wrapping,
            clock,
            logger,
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
        ...Object.values(aggregates.byName)
          .filter(takesSnapshots)
          .map((aggregate) =>
            createSnapshotSubscriber({
              aggregate,
              eventStore: storage.eventStore,
              snapshotStore: storage.snapshotStore,
              loader,
              logger,
              ...(test === undefined ? {} : { strict: { onError: test.onSnapshotError } }),
            }),
          ),
        ...(retention === undefined
          ? []
          : [createRetentionSubscriber({ persons: storage.persons })]),
        ...(ledger === null ? [] : [createLedgerOutbox({ ledger, keepForMs, clock })]),
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
      restrictedRetries: createRestrictedRetries({ storage, retries, clock, logger }),
      retention,
      rotation,
      reconciliation,
      reactive: following.map((subscriber) => subscriber.name),
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
    const scheduledDueAt = (): Promise<Date | null> =>
      storage.scheduler.nextDueAt({ leaseMs: worker.leaseMs });
    // A test app's `runUntilIdle` moves its clock to what `scheduledDueAt` says, never to a
    // retention deadline: that would forget every person the test created.
    const nextDueAt = async (): Promise<Date | null> => {
      const due = await Promise.all([
        scheduledDueAt(),
        retention?.nextDueAt() ?? null,
        rotation?.nextDueAt() ?? null,
        reconciliation?.nextDueAt() ?? null,
      ]);
      return due.reduce<Date | null>(
        (earliest, at) =>
          at === null || (earliest !== null && earliest.getTime() <= at.getTime()) ? earliest : at,
        null,
      );
    };
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

    const events = createGlobalStream({ eventStore: written.eventStore });
    const getLag = async (): Promise<AppLag> => ({
      ...(await dispatcher.getLag()),
      waitingDeadlines: worker.waitingDeadlines(),
      forgetLedger:
        reconciliation === undefined ? null : { reconciled: reconciliation.reconciled() },
    });
    // Before the app serves anything: a backup restored brings back persons forgotten since, and
    // the read models that show them hear of it by the time the start resolves. A ledger that
    // does not answer in time is left to finish behind the start, as one that fails is retried,
    // unless the ledger is strict, whose start waits and fails with it.
    if (reconciliation !== undefined) {
      const reconciling = reconciliation.reconcile(clock.now());
      const forgotten = ledgerConfig?.strict
        ? await reconciling
        : await waitForLedger(clock, reconciling);
      if (forgotten === "late") {
        logger.error(
          "forget ledger did not answer in time; the app starts and reconciles in the background",
          { timeoutMs: FORGET_LEDGER_WAIT_MS },
        );
      } else if (typeof forgotten !== "number") {
        if (ledgerConfig?.strict) throw new ForgetLedgerUnreconciledError(forgotten.failed);
      } else if (forgotten > 0) {
        await dispatcher.catchUp("projection");
      }
    }
    const rebuild = (
      name: string,
      options: RebuildReadModelOptions & { readonly actor?: string } = {},
    ) => rebuildReadModelWith({ registry, config: rawConfig, name, logger, wrapping, ...options });
    const clientAs = (
      actor: string | undefined,
    ): BoundaClient<R> & { readonly deadLetters: DeadLetters } => {
      const exportAs = async (personId: string): Promise<PersonalDataExport> => {
        checkPersonId(personId, "exportPersonalData");
        let exported: PersonalDataExport | undefined;
        return recorded(
          (outcome) =>
            recordAccess({
              operation: "exportPersonalData",
              detail:
                exported === undefined
                  ? null
                  : {
                      events: exported.events.length,
                      scheduledCommands: exported.scheduledCommands.length,
                      deadLetters: exported.deadLetters.length,
                      readModelRows: Object.values(exported.readModels).reduce(
                        (sum, rows) => sum + rows.length,
                        0,
                      ),
                    },
              actor,
              persons: [personId],
              outcome,
            }),
          async () => {
            exported = await exportPersonalData({
              storage,
              aggregates,
              processes: processDefinitions,
              readModels,
              clock,
              batchSize: config.runtime.dispatcher.batchSize,
              personId,
            });
            return exported;
          },
        );
      };
      return {
        commands: createCommandsFacade({
          aggregates,
          dispatch: (command) => pipeline.dispatch({ ...command, actor }),
        }) as CommandsFacade<R>,
        queries: queryRunner.facade(actor) as QueriesFacade<R>,
        getLag,
        events,
        deadLetters: createDeadLetters({
          storage,
          retries,
          processes,
          clock,
          logger,
          actor,
          recordAccess,
        }),
        rebuildReadModel: (name) =>
          tracedOperation({
            operation: "rebuildReadModel",
            actor,
            run: () => rebuild(name, actor === undefined ? {} : { actor }),
          }),
        forget: (personId) =>
          tracedOperation({
            operation: "forget",
            actor,
            run: () =>
              forgetPersonalData({
                storage,
                ids,
                clock,
                logger,
                concurrencyRetries,
                personId,
                actor,
              }),
          }),
        exportPersonalData: (personId) =>
          tracedOperation({
            operation: "exportPersonalData",
            actor,
            run: () => exportAs(personId),
          }),
        restrict: (personId) =>
          tracedOperation({
            operation: "restrict",
            actor,
            run: () =>
              restrictProcessing({
                storage,
                ids,
                clock,
                logger,
                concurrencyRetries,
                personId,
                actor,
              }),
          }),
        unrestrict: (personId) =>
          tracedOperation({
            operation: "unrestrict",
            actor,
            run: () =>
              liftProcessingRestriction({
                storage,
                ids,
                clock,
                logger,
                concurrencyRetries,
                personId,
                actor,
              }),
          }),
        as: (next) => {
          checkActor(next);
          return clientAs(next);
        },
      };
    };

    return {
      ...clientAs(undefined),
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
              try {
                await storage.close();
              } finally {
                wrapping.close();
                await ledger?.close?.();
              }
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
            if (!(await pendingRetries.skipToNext(scheduledDueAt, nextRetryAt))) {
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
      rebuildReadModel: rebuild,
      forgetAgain: async (entries, { actor } = {}) => {
        if (actor !== undefined) checkActor(actor);
        for (const { personId } of entries) checkPersonId(personId, "forgetAgain");
        const forgotten: string[] = [];
        for (const entry of entries) {
          const again = await forgetAgain({
            storage: written,
            ids,
            clock,
            concurrencyRetries,
            entry,
            actor,
          });
          if (again === null) continue;
          logForgotten(logger, again);
          wrapping.drop(entry.personId);
          forgotten.push(entry.personId);
        }
        return forgotten;
      },
      pendingRebuilds: async () => {
        const paused = await Promise.all(
          Object.values(readModels.byName).map(async ({ name, storage }) =>
            (await pendingRebuilds(storage.checkpointStore)).includes(name) ? [name] : [],
          ),
        );
        return paused.flat();
      },
    };
  } catch (error) {
    for (const close of opened) await close().catch(() => undefined);
    await ports.dispose();
    throw error;
  }
};
