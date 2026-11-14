import type { ObservableResult } from "@opentelemetry/api";
import { isAdapter } from "../adapter/adapter.ts";
import { checkConfigNames } from "../config/names.ts";
import { resolveConfig } from "../config/schema.ts";
import type {
  Config,
  ResolvedConfig,
  ResolvedForgetLedgerConfig,
  RuntimeRole,
} from "../config/types.ts";
import { type Clock, systemClock } from "../contracts/clock.ts";
import type { CommandRejection, DispatchResult, StoredDispatch } from "../contracts/command.ts";
import { ConfigurationError, ForgetLedgerUnreconciledError } from "../contracts/errors.ts";
import { type IdGenerator, uuidV7IdGenerator } from "../contracts/ids.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import { checkActor } from "../contracts/metadata.ts";
import type { OnPersonalDataAccess } from "../modules/audit.ts";
import type {
  ForgetOptions,
  RestrictOptions,
  UnrestrictOptions,
} from "../modules/personal-data.ts";
import type { RedactOptions } from "../modules/redaction.ts";
import type { CommandsFacade, QueriesFacade, Registry } from "../modules/registry.ts";
import { validateRegistry } from "../modules/validate.ts";
import type { AppEnv, AppRegistry, EnvSection } from "../register/index.ts";
import { buildAggregates } from "./aggregate/build-aggregates.ts";
import { createAggregateLoader } from "./aggregate/load-aggregate.ts";
import { createCommandsFacade } from "./command/facade.ts";
import { createCommandPipeline } from "./command/pipeline.ts";
import { createDeadLetters, type DeadLetters } from "./dead-letters/dead-letters.ts";
import { createRestrictedRetries } from "./dead-letters/restricted.ts";
import { createDeadLetterRetention } from "./dead-letters/retention.ts";
import { createDeadLetterRetry } from "./dead-letters/retry.ts";
import { createDispatcher, type DispatcherLag } from "./dispatch/dispatcher.ts";
import { createLastFailures } from "./dispatch/last-failures.ts";
import { alignReactiveCheckpoints } from "./dispatch/reactive-checkpoints.ts";
import {
  createSubscriberFailures,
  type SubscriberFailures,
} from "./dispatch/subscriber-failures.ts";
import { appStorage } from "./events/app-event-store.ts";
import { createGlobalStream, type GlobalStream } from "./events/global-stream.ts";
import { createAccessLog, recorded } from "./personal-data/access.ts";
import { createPersonalDataBackfill } from "./personal-data/backfill.ts";
import { buildPersonalCategories, checkMarkedCategories } from "./personal-data/categories.ts";
import { exportPersonalData, type PersonalDataExport } from "./personal-data/export.ts";
import { forgetPersonalData, logForgotten } from "./personal-data/forget.ts";
import {
  type BoundedForgetLedger,
  boundForgetLedger,
  openForgetLedger,
  waitForLedger,
} from "./personal-data/forget-ledger.ts";
import { createForgetIntentions } from "./personal-data/intention.ts";
import { createLedgerOutbox } from "./personal-data/ledger-outbox.ts";
import { marksPersonalFields } from "./personal-data/marks.ts";
import {
  createForgetLedgerReconciliation,
  type ForgetAgainEntry,
  forgetAgain,
  NEVER_DUE,
} from "./personal-data/reconciliation.ts";
import { type Redactions, redactPersonalData, settleRedaction } from "./personal-data/redact.ts";
import { marksFingerprint } from "./personal-data/resealing.ts";
import {
  createRestrictedPersonsSubscriber,
  restrictedPersonsHosts,
} from "./personal-data/restricted-persons.ts";
import { restrictProcessing, unrestrictProcessing } from "./personal-data/restriction.ts";
import {
  createRetentionSubscriber,
  createRetentionSweep,
  retains,
  retentionDueOf,
} from "./personal-data/retention.ts";
import { createKeyRotation } from "./personal-data/rotation.ts";
import { checkPersonId } from "./personal-data/transact.ts";
import { type PersonalDataWitness, witnessedWrapping } from "./personal-data/witness.ts";
import { buildPersonalKeyWrapping } from "./personal-data/wrapped-keys.ts";
import { buildPolicies } from "./policy/build-policies.ts";
import { createDelayedPolicies } from "./policy/delayed.ts";
import { createPolicyExecutor } from "./policy/executor.ts";
import { createPolicySubscriber } from "./policy/runner.ts";
import { createPorts, type TestChoice } from "./ports/ports.ts";
import { buildProcesses } from "./process/build-processes.ts";
import { createProcessRunner } from "./process/runner.ts";
import { createProjectionSubscriber, projectionSubscriberName } from "./projection/runner.ts";
import { buildQueries } from "./query/build-queries.ts";
import { createQueryRunner } from "./query/runner.ts";
import { adapterForReadModel, buildReadModels } from "./read-model/build-read-models.ts";
import {
  pendingRebuilds,
  type RebuildReadModelResult,
  rebuildReadModelWith,
  rebuildsPassed,
} from "./read-model/rebuild.ts";
import { openReadModelSealing, settleReadModels } from "./read-model/sealing.ts";
import { createScheduledCommandWorker } from "./scheduler/worker.ts";
import { withCommittedEvents } from "./shared/committed-events.ts";
import { guardedLogger } from "./shared/guarded-logger.ts";
import { ignoredRetries, type PendingRetries } from "./shared/pending-retries.ts";
import { createRestoreWatch, GENERATION_INTERVAL_MS, type Restored } from "./shared/restores.ts";
import { createSnapshotSubscriber, takesSnapshots } from "./snapshot/subscriber.ts";
import { type AppStatus, readAppStatus } from "./status.ts";
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
  /**
   * Where the runtime's background work stands, as the database says: the versions of its tables,
   * every subscriber's lag and last failure without its text, the backfill of personal data, the
   * forget ledger's reconciliation, the key rotation, the retention and the purge of dead letters.
   * What `bounda status` prints. Records nothing in the access log: none of it is personal data.
   */
  status(): Promise<AppStatus>;
  /**
   * Each subscriber's last failure with its text opened; each call that finds one is recorded in
   * the access log, as `exportPersonalData` is.
   */
  readonly subscriberFailures: SubscriberFailures;
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
   * Forgets a person: deletes the keys their personal fields are encrypted with, one per
   * category, so every event of theirs, and the state of every process instance that names them,
   * reads those fields as `null` from now on, the instance carrying on, and appends
   * `PersonalDataForgotten` to the stream `bounda:<personId>`, which every read model that
   * projects personal fields handles. With `categories`, only those, as when a consent is
   * withdrawn. A category whose basis is `legal-obligation` is kept instead, restricted, until its
   * retention ends. Both happen together or not at all. Resolves like a command, so
   * `catchUpReadModels({ through })` waits for those read models. Rejects with
   * `ValidationError` an empty id, or categories that are empty or that the app does not have.
   * With `runtime.personalData.forgetLedger`, the forgetting is in the ledger before it commits:
   * one that rejects after that still forgets what it asked for at the next reconciliation, and
   * calling again is safe; a strict ledger that does not take it rejects with
   * `ForgetLedgerUnavailableError`, forgetting nothing.
   */
  forget(personId: string, options?: ForgetOptions): Promise<StoredDispatch>;
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
   * Restricts the processing of a person's data on a ground of article 18(1), of some categories
   * or of the person as a whole: from then on it is only kept. A command that touches a person
   * restricted as a whole, or would read or write data of theirs it covers, is refused with
   * `ProcessingRestrictedError` before its handler runs; a policy, process step or scheduled
   * command that would waits as a dead letter with that code, retried once it is lifted; a query
   * leaves their rows out; a dead letter keeps their data sealed. A basis of article 18(2) named
   * explicitly lets each through, recorded. Records it and appends `ProcessingRestricted` to the
   * stream `bounda:<personId>` together, cancelling a lift announced on the ground, and resolves
   * like a command, so `catchUpReadModels({ through })` waits for the read models. A restriction
   * that adds nothing appends nothing and resolves without events. `forget` and the export stay
   * allowed. Rejects with `ValidationError` an empty id, a ground article 18(1) does not name,
   * or categories that are empty or that the app does not have.
   */
  restrict(personId: string, options: RestrictOptions): Promise<StoredDispatch>;
  /**
   * Lifts the person's restrictions on `ground`, every ground without it, of `categories`, every
   * category without them. Article 18(3) asks that the person be told first: with a `notice`
   * duration it appends `ProcessingRestrictionLiftAnnounced`, which the app tells them from, and
   * lifts that long after, unless a `restrict` on the ground comes first; with `"given"` it lifts
   * at once. A lift appends `ProcessingRestrictionLifted`, and the runtime then retries, in the
   * background, every dead letter the restriction caused, in order. Nothing to lift appends
   * nothing and resolves without events. Rejects with `ValidationError` an empty id, a missing or
   * non-positive notice, an unknown ground or category, or categories of a restriction of the
   * person as a whole.
   */
  unrestrict(personId: string, options: UnrestrictOptions): Promise<StoredDispatch>;
  /**
   * Rectification (article 16): seals for good the fields named of the events named, each one an
   * event of the person's export with the personal fields whose value is wrong, so from then on
   * they read as `null`, as forgotten ones do, everywhere: every handler, upcaster and rebuild
   * reads `null`, the export lists the redaction and never the old value, and every read model
   * that holds the person's personal fields writes `null` over each copy of an old value as it
   * projects the `PersonalDataRedacted` appended to the stream `bounda:<personId>`. Snapshots of
   * those streams and the person's remembered rejections go, and so do the scheduled commands and
   * dead letters whose payload holds an old value; an error text quoting one is sealed for good.
   * Append the corrected value as an event of the app's own. Resolves like a command, so
   * `catchUpReadModels({ through })` waits for the read models. A field no key of the person
   * opens any more, redacted or forgotten already, is left as it is, and nothing left to redact
   * appends nothing. With `runtime.personalData.forgetLedger`, the redaction is in the ledger
   * before it commits, and a restore applies it again. Allowed while the person's processing is
   * restricted. Rejects with `ValidationError` an empty id, no events, a field the event type does
   * not mark `personal`, and an event the store does not hold or that does not name the person.
   */
  redact(personId: string, options: RedactOptions<R>): Promise<StoredDispatch>;
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
   * Starts background work: the dispatcher and the scheduled command worker. For `role: "web"`,
   * only the watch for a database restored under the app, which forgets again at once whom the
   * copy brought back.
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
   * rewrapped under `runtime.personalData.keyWrapper`, `runtime.personalData.forgetLedger` is to
   * be read again, after a read that failed or once a ledger that shows entries late has had the
   * time to, or a resolved dead letter outlives `runtime.deadLetters.retention`; `null` when
   * nothing is. A person, a key, a ledger read or a purge that failed counts from the end of its
   * wait, never from now. A host without a polling worker arms its wake-up for it.
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
   * Commits again each forgetting an entry names, of the categories it asked for, as a
   * reconciliation does: unless the store holds the `PersonalDataForgotten` the entry names by
   * `eventId`, and only while the person holds a key in force it covers and names, any such key
   * when it names none; a whole entry under its own id, time and reason, a bare
   * person's id as a request. What `bounda forget --from` runs, for a backup restored without
   * `runtime.personalData.forgetLedger`; with one, each is recorded in it first, as `forget` does.
   * Resolves to the ids of the persons it forgot, in order. Rejects with `ValidationError` an entry
   * without a person's id, or an `actor` that `as` would refuse, before forgetting anyone.
   */
  forgetAgain(
    entries: readonly ForgetAgainEntry[],
    options?: ForgetAgainOptions,
  ): Promise<readonly string[]>;
  /**
   * Says the database was restored from a copy: what `bounda restored` runs after restoring while
   * the app was stopped, without a forget ledger that tells it. Counts the restore, so every
   * running instance starts its background jobs over, clears the holds the copy brought back, and
   * reconciles the forget ledger at once when there is one. A restore made under a running app,
   * or while it was stopped with a ledger, is found without it.
   */
  restored(): Promise<void>;
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
  /**
   * `null` when no schema marks personal data. Marks added or changed seal in the background what
   * was written before them: until `caughtUp`, an export or a forget may miss what they now mark
   * in older events, scheduled commands and dead letters.
   */
  readonly personalDataBackfill: PersonalDataBackfillLag | null;
}

export interface ForgetLedgerLag {
  readonly reconciled: boolean;
}

/**
 * How far the runtime has sealed what was written before the personal data marks of now.
 */
export interface PersonalDataBackfillLag {
  /**
   * The global position through which the events are sealed.
   */
  readonly position: number;
  /**
   * Whether the walk has sealed the stream up to its head and every scheduled command and dead
   * letter as the marks of now say. What is written after is sealed as it is written; an
   * instance still on older marks, as in a rolling deploy, makes it `false` again until what it
   * wrote is sealed.
   */
  readonly caughtUp: boolean;
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
  /**
   * Given by `createTestApp`: told of the keys and the ledger the app holds.
   */
  readonly witness?: PersonalDataWitness | undefined;
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
  witness,
}: AssembleAppArgs<R>): Promise<BoundaApp<R>> => {
  validateRegistry(registry);
  const config = resolveConfig(rawConfig);
  checkConfigNames({ registry, config });
  const { errorText } = config.runtime.telemetry;
  const logger = guardedLogger(rawLogger, errorText);
  if (!isAdapter(config.storage)) {
    throw new ConfigurationError(
      `storage "${config.storage.name}" is a definition without factories. Import the adapter package's factory.`,
    );
  }
  // Built first: a master key missing from the environment fails the start before anything opens.
  const built = await buildPersonalKeyWrapping({
    definition: config.runtime.personalData.keyWrapper,
    env,
    clock,
  });
  const wrapping = witness === undefined ? built : witnessedWrapping(built, witness);
  // Built before the storage opens and closed after it, so a `create` that fails leaves nothing
  // open; a failure further on closes them again.
  const ports = await createPorts({
    registry,
    env,
    tenant,
    logger: guardedLogger(rawLogger, errorText, { thrownAsError: false }),
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
    let forgetLedger: {
      readonly config: ResolvedForgetLedgerConfig;
      readonly store: BoundedForgetLedger;
    } | null = null;
    if (ledgerConfig !== null) {
      const ledger = await openForgetLedger({
        source: ledgerConfig.store,
        storage: config.storage,
        env,
        tenant,
        keepForMs: keepForMs ?? undefined,
      });
      witness?.onForgetLedger(ledger);
      if (ledger.close !== undefined) opened.unshift(ledger.close.bind(ledger));
      forgetLedger = {
        config: ledgerConfig,
        store: boundForgetLedger({ ledger, timeoutMs: ledgerConfig.timeoutMs, clock }),
      };
    }
    const intentions = createForgetIntentions({
      ledger:
        forgetLedger === null
          ? null
          : { store: forgetLedger.store, strict: forgetLedger.config.strict },
      ids,
      clock,
      logger,
    });
    const restores = createRestoreWatch({
      checkpoints: adapted.checkpointStore,
      events: adapted.eventStore,
      marks: forgetLedger?.store ?? null,
      logger,
    });
    // Every event this instance commits is the newest the watch knows of until it reads another.
    const written = withCommittedEvents({
      storage: adapted,
      committed: (events) => {
        for (const event of events) restores.saw(event);
      },
    });
    const aggregates = buildAggregates({ registry, ports: ports.byAggregate, config });
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
    const personalCategories = buildPersonalCategories({
      module: registry.personalData,
      retention: config.runtime.personalData.retention,
    });
    checkMarkedCategories({
      categories: personalCategories,
      aggregates,
      processes: processDefinitions,
      readModels: readModels.byName,
    });
    const sealing = await openReadModelSealing({
      layouts: Object.values(readModels.byName).map(({ layout }) => layout),
      keys: storage.personalKeys,
      indexKeys: written.indexKeys,
      wrapping,
      clock,
      scheduler: written.scheduler,
    });
    await settleReadModels({ readModels: Object.values(readModels.byName), sealing, logger });
    // One list per `runUntilIdle` under way.
    const observers = new Set<CommandRejection[]>();
    const recordAccess = createAccessLog({
      hook: test === undefined ? registry.audit?.onPersonalDataAccess : onPersonalDataAccess,
      env,
      tenant,
      logger,
      clock,
    });
    const pipeline = createCommandPipeline({
      aggregates,
      loader,
      storage,
      config,
      ids,
      clock,
      logger,
      recordAccess,
      onRejection: (rejection) => {
        for (const observed of observers) observed.push(rejection);
      },
    });
    const queryRunner = createQueryRunner({
      queries: buildQueries({ readModels }),
      readModels,
      sealing,
      ports: ports.byReadModel,
      recordAccess,
      errorText,
    });
    const processes = createProcessRunner({
      processes: processDefinitions,
      aggregates,
      pipeline,
      storage,
      config,
      personalCategories,
      ids,
      clock,
      pendingRetries,
      logger,
      intentions,
      recordAccess,
    });
    const policies = buildPolicies({ registry, aggregates });
    const policyExecutor = createPolicyExecutor({
      aggregates,
      pipeline,
      config,
      personalCategories,
      ids,
      clock,
      logger,
      intentions,
      keys: storage.personalKeys,
      recordAccess,
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
      clock,
    });
    await alignReactiveCheckpoints({
      eventStore: storage.eventStore,
      checkpointStore: storage.checkpointStore,
      following: following.map((subscriber) => subscriber.name),
    });
    // Without a retention the sweep still ends what a forgetting kept that no legal obligation keeps
    // any more, which only an app that marks personal fields can hold.
    const recordsActivity = retains(personalCategories);
    const retention =
      recordsActivity || marksPersonalFields({ aggregates, processes: processDefinitions })
        ? createRetentionSweep({
            storage: written,
            intentions,
            categories: personalCategories,
            ids,
            clock,
            logger,
            concurrencyRetries: config.runtime.commands.concurrencyRetries,
            batchSize: config.runtime.dispatcher.batchSize,
            forgotten: wrapping.drop,
          })
        : undefined;
    const letterRetentionMs = config.runtime.deadLetters.retentionMs;
    const letterRetention =
      letterRetentionMs === null
        ? undefined
        : createDeadLetterRetention({
            store: written.deadLetterStore,
            checkpoints: written.checkpointStore,
            retentionMs: letterRetentionMs,
            clock,
            logger,
          });
    const { concurrencyRetries } = config.runtime.commands;
    const redactions: Redactions = {
      storage: written,
      wrapping,
      intentions,
      aggregates,
      processes: processDefinitions,
      ids,
      clock,
      logger,
      concurrencyRetries,
      onRedacted: witness?.onRedacted,
    };
    const personalReadModels = Object.values(readModels.byName).filter(
      ({ layout }) => layout.personal.length > 0,
    );
    const retentionDue = recordsActivity
      ? retentionDueOf({
          categories: personalCategories,
          batchSize: config.runtime.dispatcher.batchSize,
          checkpoints: written.checkpointStore,
        })
      : NEVER_DUE;
    const reconciling =
      forgetLedger === null
        ? null
        : {
            config: forgetLedger.config,
            reconciliation: createForgetLedgerReconciliation({
              ledger: forgetLedger.store,
              intentions,
              retentionDue,
              storage: written,
              ids,
              clock,
              logger,
              concurrencyRetries,
              categories: personalCategories,
              batchSize: config.runtime.dispatcher.batchSize,
              reconcileEveryMs: forgetLedger.config.reconcileEveryMs,
              keepForMs,
              forgotten: wrapping.drop,
              redactions,
            }),
          };
    const reconciliation = reconciling?.reconciliation;
    const rotation =
      wrapping.wrapper === null
        ? undefined
        : createKeyRotation({
            keys: written.personalKeys,
            indexKeys: written.indexKeys,
            checkpoints: written.checkpointStore,
            wrapper: wrapping.wrapper,
            wrapping,
            clock,
            logger,
          });
    const marks = marksFingerprint({ aggregates, processes: processDefinitions });
    const backfill =
      marks === null
        ? undefined
        : createPersonalDataBackfill({
            storage: written,
            aggregates,
            processes: processDefinitions,
            wrapping,
            marks,
            batchSize: config.runtime.dispatcher.batchSize,
            recordsActivity,
            clock,
            logger,
            errorText,
          });
    // A restore found outside a worker's pass: the jobs start over and the ledger is reconciled
    // at once, unless this instance's worker handled it already. Resolves how many it forgot. It
    // reads the worker, built after the dispatcher, only when called: no pass runs before.
    const restartFound = async (found: Restored): Promise<number> => {
      if (!(await worker.restored(found))) return 0;
      const forgotten = await reconciliation?.reconcile(clock.now());
      return typeof forgotten === "number" ? forgotten : 0;
    };
    const dispatcher = createDispatcher({
      eventStore: storage.eventStore,
      checkpointStore: storage.checkpointStore,
      subscribers: [
        ...Object.values(readModels.byName).map((readModel) =>
          createProjectionSubscriber({
            readModel,
            sealing,
            logger,
            errorText,
            budget: { clock, maxMs: config.runtime.dispatcher.projectionBatchTimeMs },
          }),
        ),
        ...restrictedPersonsHosts({
          readModels: Object.values(readModels.byName),
          adapterOf: (name) => adapterForReadModel({ name, config }),
        }).map((readModel) => createRestrictedPersonsSubscriber({ readModel, logger, errorText })),
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
        ...(recordsActivity
          ? [createRetentionSubscriber({ persons: storage.persons, keys: storage.personalKeys })]
          : []),
        ...(forgetLedger === null
          ? []
          : [createLedgerOutbox({ ledger: forgetLedger.store, keepForMs, clock })]),
      ],
      batchSize: config.runtime.dispatcher.batchSize,
      pollIntervalMs: config.runtime.dispatcher.pollIntervalMs,
      backoff: config.runtime.dispatcher.backoff,
      catchUp: config.runtime.dispatcher.catchUp,
      idleIntervalMs: config.runtime.dispatcher.idleIntervalMs,
      ...(storage.notifier === undefined ? {} : { notifier: storage.notifier }),
      lastFailures: createLastFailures({
        store: written.subscriberFailures,
        aggregates,
        keys: storage.personalKeys,
        logger,
      }),
      // Nothing is delivered on a restored database before whom it brought back is forgotten again:
      // the pass then delivers that forgetting to the read models.
      beforePass: async () => {
        const found = await restores.check(clock.now());
        if (found !== null) await restartFound(found);
      },
      clock,
      logger,
      errorText,
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
      letterRetention,
      rotation,
      reconciliation,
      intentions,
      backfill,
      redactionScrubs: {
        passed: async (position) => {
          for (const { name, storage: own } of personalReadModels) {
            const at = await own.checkpointStore.get(projectionSubscriberName(name));
            if (at < position) return false;
            const rebuilt = await rebuildsPassed({
              checkpointStore: own.checkpointStore,
              name,
              position,
            });
            if (!rebuilt) return false;
          }
          return true;
        },
        settle: (entry) =>
          settleRedaction({
            redactions,
            entry,
            batchSize: config.runtime.dispatcher.batchSize,
          }),
      },
      restores,
      onRestored: dispatcher.restored,
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
        letterRetention?.nextDueAt() ?? null,
        rotation?.nextDueAt() ?? null,
        reconciliation?.nextDueAt() ?? null,
        backfill?.nextDueAt() ?? null,
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
      personalDataBackfill: backfill === undefined ? null : await backfill.status(),
    });
    const status = (): Promise<AppStatus> =>
      readAppStatus({
        config,
        lag: getLag,
        failures: written.subscriberFailures,
        restores,
        reconciliation,
        rotation,
        retention,
        letterRetention,
      });
    // A copy restored while the app was stopped holds less than the forget ledger's mark: the
    // holds it brought back are cleared before anything runs, and the reconciliation below forgets
    // again whom it brought back.
    const cold = await restores.start();
    if (cold !== null) await worker.restored(cold);
    // An instance that runs no worker still watches for a restore, and reconciles the ledger at
    // once when it finds one, since no pass of its own would.
    const watchForRestores = (): (() => void) => {
      let cancel: (() => void) | undefined;
      const next = (): void => {
        cancel = clock.after(GENERATION_INTERVAL_MS, async () => {
          const found = await restores.check(clock.now());
          if (found !== null && (await restartFound(found)) > 0) {
            await dispatcher.catchUp("projection");
          }
          next();
        });
      };
      next();
      return () => cancel?.();
    };
    let unwatch: (() => void) | undefined;
    // Before the app serves anything: a backup restored brings back persons forgotten since, and
    // the read models that show them hear of it by the time the start resolves. A ledger that
    // does not answer in time is left to finish behind the start, as one that fails is retried,
    // unless the ledger is strict, whose start waits and fails with it.
    if (reconciling !== null) {
      const { strict, timeoutMs } = reconciling.config;
      const started = reconciling.reconciliation.reconcile(clock.now());
      const forgotten = strict ? await started : await waitForLedger(clock, timeoutMs, started);
      if (forgotten === "late") {
        logger.error(
          "forget ledger did not answer in time; the app starts and reconciles in the background",
          { timeoutMs },
        );
      } else if (typeof forgotten !== "number") {
        if (strict) throw new ForgetLedgerUnreconciledError(forgotten.failed);
      } else if (forgotten > 0) {
        // The ledger held a forgetting the database does not: a restore, whatever the mark said.
        if (cold === null) {
          await worker.restored(await restores.declare(), { reconciled: true });
        }
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
                      subscriberFailures: exported.subscriberFailures.length,
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
              sealing,
              clock,
              batchSize: config.runtime.dispatcher.batchSize,
              categories: personalCategories,
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
        status: () => tracedOperation({ errorText, operation: "status", actor, run: status }),
        subscriberFailures: createSubscriberFailures({
          store: written.subscriberFailures,
          keys: storage.personalKeys,
          persons: storage.persons,
          actor,
          recordAccess,
          errorText,
        }),
        events,
        deadLetters: createDeadLetters({
          storage,
          retries,
          processes,
          clock,
          logger,
          errorText,
          actor,
          recordAccess,
        }),
        rebuildReadModel: (name) =>
          tracedOperation({
            errorText,
            operation: "rebuildReadModel",
            actor,
            run: () => rebuild(name, actor === undefined ? {} : { actor }),
          }),
        forget: (personId, options) =>
          tracedOperation({
            errorText,
            operation: "forget",
            actor,
            run: () =>
              forgetPersonalData({
                storage,
                intentions,
                ids,
                clock,
                logger,
                concurrencyRetries,
                categories: personalCategories,
                batchSize: config.runtime.dispatcher.batchSize,
                personId,
                options,
                actor,
              }),
          }),
        exportPersonalData: (personId) =>
          tracedOperation({
            errorText,
            operation: "exportPersonalData",
            actor,
            run: () => exportAs(personId),
          }),
        restrict: (personId, options) =>
          tracedOperation({
            errorText,
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
                categories: personalCategories,
                intentions,
                options,
              }),
          }),
        unrestrict: (personId, options) =>
          tracedOperation({
            errorText,
            operation: "unrestrict",
            actor,
            run: () =>
              unrestrictProcessing({
                storage,
                ids,
                clock,
                logger,
                concurrencyRetries,
                personId,
                actor,
                categories: personalCategories,
                intentions,
                options,
              }),
          }),
        redact: (personId, options) =>
          tracedOperation({
            errorText,
            operation: "redact",
            actor,
            run: () =>
              redactPersonalData({
                redactions,
                personId,
                options,
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
        if (stopping !== undefined) return;
        if (role === "web") {
          unwatch ??= watchForRestores();
          return;
        }
        dispatcher.start();
        worker.start();
      },
      stop: () => {
        stopping ??= (async () => {
          try {
            lag.removeCallback(observeLag);
            unwatch?.();
            await Promise.all([dispatcher.stop(), worker.stop()]);
            await restores.flush();
            try {
              await readModels.close();
            } finally {
              try {
                await storage.close();
              } finally {
                wrapping.close();
                await forgetLedger?.store.close?.();
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
            intentions,
            ids,
            clock,
            concurrencyRetries,
            categories: personalCategories,
            batchSize: config.runtime.dispatcher.batchSize,
            entry,
            retentionDue,
            record: true,
            actor,
          });
          if (again === null) continue;
          logForgotten(logger, again);
          wrapping.drop(entry.personId);
          forgotten.push(entry.personId);
        }
        return forgotten;
      },
      restored: async () => {
        await restartFound(await restores.declare());
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
