import type { ObservableResult } from "@opentelemetry/api";
import { type Adapter, isAdapter, type Storage } from "../adapter/adapter.ts";
import type { CheckpointStore } from "../adapter/storage/checkpoint-store.ts";
import type { DeadLetterKind } from "../adapter/storage/dead-letter-store.ts";
import type { DeclaredRecipient } from "../adapter/storage/recipient-store.ts";
import { fenceError } from "../adapter/storage/tenant-fence.ts";
import type { PendingRecipientDeclaration } from "../adapter/storage/tenant-key-store.ts";
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
import {
  ConfigurationError,
  ForgetLedgerUnreconciledError,
  RebuildSupersededError,
  RestoreUnreconciledError,
  TenantForgottenError,
  ValidationError,
} from "../contracts/errors.ts";
import type { StoredEvent } from "../contracts/event.ts";
import { type IdGenerator, uuidV7IdGenerator } from "../contracts/ids.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import { checkActor } from "../contracts/metadata.ts";
import type {
  ExportOutcome,
  OnHostRejection,
  OnPersonalDataAccess,
  ReadOutcome,
} from "../modules/audit.ts";
import type {
  ForgetOptions,
  RestrictOptions,
  UnrestrictOptions,
} from "../modules/personal-data.ts";
import type { PersonRecipient } from "../modules/recipient.ts";
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
import {
  createDispatcher,
  type DispatcherLag,
  type SubscriberLag,
  type UnreadableSubscriberLag,
} from "./dispatch/dispatcher.ts";
import { createSubscriberFailureRetention } from "./dispatch/failure-retention.ts";
import { createLastFailures } from "./dispatch/last-failures.ts";
import { alignReactiveCheckpoints } from "./dispatch/reactive-checkpoints.ts";
import {
  createSubscriberFailures,
  type SubscriberFailures,
} from "./dispatch/subscriber-failures.ts";
import { appStorage } from "./events/app-event-store.ts";
import { createGlobalStream, type GlobalStream } from "./events/global-stream.ts";
import { createForgottenRunner, type ForgottenRunner, forgottenApp } from "./forgotten-app.ts";
import { createHostLog, recordedRejections } from "./host-log.ts";
import { checked, createAccessLog, recorded } from "./personal-data/access.ts";
import { createPersonalDataBackfill } from "./personal-data/backfill.ts";
import { openDatabaseKey } from "./personal-data/blind-index.ts";
import { buildPersonalCategories, checkMarkedCategories } from "./personal-data/categories.ts";
import { checkClassification } from "./personal-data/classification.ts";
import { logClearFields } from "./personal-data/clear-fields.ts";
import { createCommittedCopies } from "./personal-data/committed-copies.ts";
import { createEarlierAnswers } from "./personal-data/earlier-answers.ts";
import { openEncryptedFiles } from "./personal-data/encrypted-files.ts";
import {
  collectPersonalDataExport,
  NO_EXPORTED_RECORDS,
  type PersonalDataExport,
  type PersonalDataExportOptions,
  type PersonalDataExportPart,
} from "./personal-data/export.ts";
import { recordedExport, streamPersonalData } from "./personal-data/export-stream.ts";
import { createFileEncryptions } from "./personal-data/file-encryption.ts";
import { forgetPersonalData, logForgotten } from "./personal-data/forget.ts";
import {
  type BoundedForgetLedger,
  boundForgetLedger,
  openForgetLedger,
  waitForLedger,
} from "./personal-data/forget-ledger.ts";
import { createForgottenLedger } from "./personal-data/forgotten-ledger.ts";
import {
  type ForgetTenantOptions,
  settleTenantForgetting,
  TENANT_CHECK_INTERVAL_MS,
  type TenantForgottenResult,
} from "./personal-data/forgotten-tenant.ts";
import { createForgetIntentions } from "./personal-data/intention.ts";
import { keySourcesOf, openKeyHierarchy } from "./personal-data/key-hierarchy.ts";
import { buildKeyWrapper } from "./personal-data/key-wrapper.ts";
import { createLedgerOutbox } from "./personal-data/ledger-outbox.ts";
import { marksPersonalFields } from "./personal-data/marks.ts";
import {
  createForgetLedgerReconciliation,
  type ForgetAgainEntry,
  type ForgetLedgerReconciliation,
  forgetAgain,
  NEVER_DUE,
} from "./personal-data/reconciliation.ts";
import { type Redactions, redactPersonalData, settleRedaction } from "./personal-data/redact.ts";
import { createPersonalDataReseal } from "./personal-data/reseal.ts";
import { marksFingerprint, walkFingerprint } from "./personal-data/resealing.ts";
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
import {
  NO_TENANT_EXPORT_RECORDS,
  type TenantExportCounts,
  type TenantExportPart,
} from "./personal-data/tenant-export.ts";
import { recordedTenantExport, streamTenantExport } from "./personal-data/tenant-export-stream.ts";
import { guardClient } from "./personal-data/tenant-guard.ts";
import type { TenantKeys } from "./personal-data/tenant-keys.ts";
import { checkPersonId, isPersonId } from "./personal-data/transact.ts";
import { storeTransfers } from "./personal-data/transfers.ts";
import { witnessedWrapping } from "./personal-data/witness.ts";
import { keylessWrapping, UNWRAPPED_KEY_TTL_MS } from "./personal-data/wrapped-keys.ts";
import { buildPolicies } from "./policy/build-policies.ts";
import { createDelayedPolicies } from "./policy/delayed.ts";
import { createPolicyExecutor } from "./policy/executor.ts";
import { createPolicySubscriber } from "./policy/runner.ts";
import { createPorts, type TestChoice } from "./ports/ports.ts";
import { buildPortReturns, portsByCategory } from "./ports/returns.ts";
import { buildProcesses } from "./process/build-processes.ts";
import { createProcessRunner } from "./process/runner.ts";
import { createProjectionSubscriber, projectionSubscriberName } from "./projection/runner.ts";
import { buildQueries } from "./query/build-queries.ts";
import { createQueryRunner } from "./query/runner.ts";
import {
  adapterForReadModel,
  buildReadModels,
  checkReadModelPersons,
  readModelsMarkPersonal,
} from "./read-model/build-read-models.ts";
import { createReadModelDatabases, watchedDatabasesOf } from "./read-model/read-model-databases.ts";
import {
  pendingRebuilds,
  REDACTION_REBUILD_BATCHES,
  type RebuildReadModelResult,
  rebuildReadModelWith,
  rebuildsPassed,
  rebuiltMark,
} from "./read-model/rebuild.ts";
import { createResealReadModels } from "./read-model/reseal-read-models.ts";
import { openReadModelSealing, settleReadModels } from "./read-model/sealing.ts";
import { buildRecipients } from "./recipients/build.ts";
import { createDisclosures, PersonalDataChangedError } from "./recipients/gate.ts";
import { recipientsOf as listRecipientsOf, recipientStatuses } from "./recipients/listing.ts";
import {
  createRecipientCatchUp,
  createRecipientDelivery,
  createRecipientNotices,
  createRecipientSubscriber,
} from "./recipients/notices.ts";
import {
  localPendingRecipients,
  type PendingRecipients,
  pendingRecipientsStore,
  recordedPendingRecipients,
  unwritten,
  withPendingDeclarations,
  writeDeclaration,
  writePendingRecipients,
} from "./recipients/pending.ts";
import { createScheduledCommandWorker } from "./scheduler/worker.ts";
import { startedBy } from "./shared/causation.ts";
import { withCommittedEvents } from "./shared/committed-events.ts";
import { guardedLogger } from "./shared/guarded-logger.ts";
import { ignoredRetries, type PendingRetries } from "./shared/pending-retries.ts";
import { createRestoreWatch, GENERATION_INTERVAL_MS, type Restored } from "./shared/restores.ts";
import type { UnreadableStatus } from "./shared/retention-status.ts";
import { runtimeText } from "./shared/runtime-text.ts";
import { createSnapshotSubscriber, takesSnapshots } from "./snapshot/subscriber.ts";
import { teedTracer } from "./span-recorder.ts";
import { type AppStatus, readAppStatus } from "./status.ts";
import {
  ATTRIBUTES,
  METRICS,
  meter,
  type TracerFunction,
  tracedOperation,
  tracer,
} from "./telemetry.ts";
import { tenantIdOf } from "./tenant.ts";
import {
  createFenceWatch,
  createFreezeKeeper,
  type FencedStores,
  fenceAwareLogger,
  freezeStores,
  type TenantFrozenResult,
  unfreezeStores,
  whollyFrozen,
} from "./tenant-fences.ts";
import { type AppWitness, type Witness, witnessedConfig, witnessHooksOf } from "./witness.ts";

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
  /**
   * How far each subscriber is behind the head of the global stream. To tell a subscriber at rest
   * from one behind, it reads the events after each checkpoint, less than one batch, once per
   * distinct checkpoint: on a Durable Object those are rows read, billed on every call. A
   * checkpoint or a backfill that cannot be read is logged and reported unreadable, `maxLag` then
   * `null`; rejects only when the stream itself, its head or the events past a checkpoint, cannot
   * be read.
   */
  getLag(): Promise<AppLag>;
  /**
   * Where the runtime's background work stands, as the database says: the versions of its tables,
   * every subscriber's lag and last failure without its text, the backfill of personal data, the
   * forget ledger's reconciliation, the key rotation, the retention and the purge of dead letters.
   * What `bounda status` prints. Records nothing in the access log: none of it is personal data.
   * Never rejects for a store it cannot read: that part is logged and reported unreadable, and
   * `unreadableParts` names every such part.
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
   * withdrawn. A category an exemption of article 17(3) applies to is kept instead, restricted,
   * until its retention ends, unless `objection` leaves it none. Both happen together or not at
   * all. Resolves like a command, so `catchUpReadModels({ through })` waits for those read
   * models. Rejects with
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
   * A field left unmarked and whatever a policy sent out are not in it. Recorded in the access log,
   * `app/audit.ts`'s `onPersonalDataAccess` or the app's logger at `info` without it: as `started`
   * once it read the header, then again before it settles, whether it resolves or fails; rejects
   * with what the hook throws. Rejects with `ValidationError` an empty id, recording nothing. When the person was
   * forgotten, restricted, lifted or redacted while it read, it reads them again, each reading
   * recorded, and rejects with `ConcurrencyError` after `runtime.commands.concurrencyRetries` more.
   * Holds the whole export in memory: for a long history, `streamPersonalData`. Text the app's
   * code wrote while it read data of someone else besides the person, an error's or a remembered
   * rejection's, may quote it, so article 15(4) holds it back: it reads `null`, named in its
   * record's `withheld`, unless `includeWithheld` opens it for the controller to weigh.
   */
  exportPersonalData(
    personId: string,
    options?: PersonalDataExportOptions,
  ): Promise<PersonalDataExport>;
  /**
   * The same export, handed out a part at a time as it is read, a page of records at most held at
   * once, whatever the person's history: the header first, then every record, section by section,
   * which `personalDataExportJson` writes as the same JSON document. Resolves once the header is
   * read and recorded in the access log as `started`, so a refusal, or a hook that throws, rejects
   * before anything is handed out. Recorded again, with the same `exportId`, when the reading
   * ends, with what it handed out by then: `ok` at the end, `failed` when a part rejects,
   * `cancelled` when its reader stops early, as `for await` does on `break` or a response body
   * when the client goes away. One its reader neither ends nor stops keeps its `started` alone.
   * Rejects the reading with `ConcurrencyError` when the person was forgotten, restricted, lifted
   * or redacted while it read, once everything was read: a new export reads them as they are.
   */
  streamPersonalData(
    personId: string,
    options?: PersonalDataExportOptions,
  ): Promise<AsyncIterable<PersonalDataExportPart>>;
  /**
   * The recipients of a person's data, as the export lists them, for the person to be told of on
   * request (article 19): those disclosed data of theirs, recorded as the port called them, with
   * the identity the port declared then; those presumed to hold it, declared after it existed or
   * after a restore without a forget ledger; and those declared for a category of theirs that may
   * still receive it. Recorded in the access log as the export is. Rejects with `ValidationError`
   * an empty id, recording nothing.
   */
  recipientsOf(personId: string): Promise<readonly PersonRecipient[]>;
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
   * categories that are empty or that the app does not have, or `objection-pending` of a category
   * no objection under article 21(1) is weighed for, one not on `public-task` or
   * `legitimate-interests` or for `direct-marketing`, or of the person as a whole while the app has
   * such a category.
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
   * projects the `PersonalDataRedacted` appended to the stream `bounda:<personId>`, over every
   * personal value of the person when it projects an event type the redaction reached, until the
   * worker has rebuilt it in the background so nothing derived from an old value is left. Snapshots of
   * those streams go, the answers remembered of the person are erased, so a dispatch under one of
   * their idempotency keys runs nothing until it expires, and so do the scheduled commands and dead
   * letters whose payload holds an old value; an error text quoting one is sealed for good.
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
   * Forgets the tenant the app serves, `tenant` naming it as a check: its key is destroyed in the
   * tenant key store, so nothing personal of the tenant opens again, in the database, in a backup
   * or in a Durable Object's copy, then `TenantForgotten` is appended, every person's key, the
   * database's key, every snapshot and remembered answer go, and the rows of the read models that
   * may hold personal data are deleted. What stays is the skeleton: ids, event types, positions,
   * times and the fields no schema marks. From then on the app serves nothing: every call rejects
   * with `TenantForgottenError`, here at once and on another instance within
   * `TENANT_CHECK_INTERVAL_MS`, and only the notices to the recipients of the tenant's data go out.
   * Calling it again resolves to the same forgetting. Rejects with `ValidationError`, forgetting
   * nothing, when `tenant` is not the app's, or while a person holds a key of a category whose
   * basis is `legal-obligation`, unless `despiteLegalObligations`; with `ConfigurationError` in an
   * app without keys.
   */
  forgetTenant(tenant: string, options?: ForgetTenantOptions): Promise<TenantForgottenResult>;
  /**
   * Hands every piece of data the runtime holds of the tenant back to the controller, as article
   * 28(3)(g) of the GDPR asks of a processor at the end of its services, before `forgetTenant` or
   * instead of it: every person, with their restrictions and the recipients of their data, every
   * event of the stream up to its head, every scheduled command, dead letter, subscriber failure
   * and remembered answer, every row of every read model and every entry of the forget ledger,
   * each with every value opened, `personal` or not, nothing held back, a value forgotten or
   * redacted `null`; never a key. A part at a time, a page of records at most held at once, in the
   * order `TenantExportPart` says, which `tenantExportJsonLines` writes as a file and
   * `readTenantExport` reads back and checks. Resolves once the header is read and recorded in
   * the access log as `started`; recorded again when the reading ends, `ok`, `failed` or
   * `cancelled`, with how many parts of each kind it handed out. Rejects the reading with
   * `ConcurrencyError`, without its `end` part, when the stream moved past the header's
   * `position` while it read. Rejects with `ValidationError`, recording it `refused`, when
   * `tenant` is not the app's, or while the tenant is not frozen with `freezeTenant` in every
   * store: the export is then one cut of all of them, which nothing changes while it reads.
   */
  exportTenant(tenant: string): Promise<AsyncIterable<TenantExportPart>>;
  /**
   * Freezes the tenant the app serves, `tenant` naming it as a check, so `exportTenant` hands it
   * back as one cut: from then on no write of the tenant lands, from this instance or any other,
   * however long ago it last read the tenant. The database, every read model's, the forget ledger
   * and the tenant key store each refuse it with `TenantFrozenError` and keep nothing of it, and
   * the background work waits. Reads go on. What the forget ledger recorded and the database did
   * not hold yet is committed first, so the stores agree. Resolves once every store is frozen, to
   * since when; calling it again resolves to the same freeze, finishing one cut short. Rejects
   * with `TenantForgottenError` for a forgotten tenant, and with `ValidationError` when `tenant`
   * is not the app's.
   */
  freezeTenant(tenant: string): Promise<TenantFrozenResult>;
  /**
   * Lifts `freezeTenant`: every store takes the tenant's writes again, and the background work
   * goes on, here at once and on another instance within `TENANT_CHECK_INTERVAL_MS`. Resolves at
   * once for a tenant not frozen. Rejects as `freezeTenant` does.
   */
  unfreezeTenant(tenant: string): Promise<void>;
  /**
   * Puts a new version of the tenant's key in force: new keys are wrapped under it, and the worker
   * rewraps every person's key and the database's key under it in the background. The older
   * versions stay in the tenant key store, opening what a backup holds under them, until
   * `retireTenantKeys`. With `reseal`, after a leak of the persons' keys themselves, the worker
   * replaces every person's key and the database's key by new ones instead, seals again under them
   * everything the store holds of persons, rebuilds the read models that hold personal data and
   * destroys the old keys; `status().keyRotation.reseal` says where it stands. Rejects with
   * `ValidationError` while a reseal keeps the keys it replaced, or, with `reseal`, while one is
   * under way at all; with `ConfigurationError` in an app without keys.
   */
  rotateTenantKey(options?: RotateTenantKeyOptions): Promise<TenantKeyVersions>;
  /**
   * Removes from the tenant key store every version of the tenant's key but the one in force, and
   * resolves to the ids it removed: a backup that holds keys wrapped under them opens nothing
   * personal any more. Rejects with `ValidationError` while a key is still wrapped under one,
   * before twice `UNWRAPPED_KEY_TTL_MS` has passed since the version in force was created, the
   * time every instance takes to wrap under it, and while a reseal keeps the keys it replaced.
   */
  retireTenantKeys(): Promise<readonly string[]>;
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
 * What `rotateTenantKey` takes.
 */
export interface RotateTenantKeyOptions {
  /**
   * Replaces every key that seals personal data, and the database's key, by new ones, and seals
   * everything again under them: what recovers from a leak of the database, the tenant key store
   * and the master key at once, after the master key itself is rotated.
   */
  readonly reseal?: boolean;
}

/**
 * The version of the tenant's key in force and the older ones the tenant key store still holds.
 */
export interface TenantKeyVersions {
  readonly kid: string;
  readonly previous: readonly string[];
  /**
   * When the version in force was created, as an ISO timestamp.
   */
  readonly since: string;
}

/**
 * A running Bounda application.
 */
export interface BoundaApp<R extends Registry = AppRegistry> extends BoundaClient<R> {
  readonly config: ResolvedConfig;
  readonly role: RuntimeRole;
  /**
   * The tenant the app serves: `DEFAULT_TENANT` unless its host named another.
   */
  readonly tenant: string;
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
   * or while it was stopped with a ledger, is found without it. Counts each restore once: made
   * again after it failed, it finishes the same declaration. While the database stands exactly
   * where handling the last restore left it, it counts nothing, starts nothing over and resolves
   * `counted: false`, as the database cannot tell a declaration made again from a copy taken at
   * that moment: `again` counts that copy.
   */
  restored(options?: RestoredOptions): Promise<RestoreDeclaration>;
}

export interface RestoredOptions {
  /**
   * The database was restored from a copy taken exactly when the last restore was handled: count
   * it though the database stands where that one left it.
   */
  readonly again?: boolean;
}

export interface RestoreDeclaration {
  /**
   * `false` when the database stood exactly where handling the last restore left it and nothing
   * was counted: the declaration was made again, or the copy was taken at that moment, which
   * `again` counts.
   */
  readonly counted: boolean;
}

/**
 * How far behind the background work is: every subscriber's lag, how many process deadlines
 * and restricted retries that came due this process holds back until the reactive runners catch
 * up, and whether the forget ledger was reconciled.
 */
export interface AppLag extends Omit<DispatcherLag, "subscribers" | "maxLag"> {
  /**
   * Every subscriber's lag, or, for one whose checkpoint could not be read, which is logged, that
   * it was not read, with what this process saw it fail on.
   */
  readonly subscribers: readonly (SubscriberLag | UnreadableSubscriberLag)[];
  /**
   * The largest lag; `null` while a subscriber's checkpoint could not be read, which may be the
   * furthest behind, so a health check never takes it for caught up.
   */
  readonly maxLag: number | null;
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
   * in older events, scheduled commands and dead letters. Unreadable, and logged, when where the
   * walk stands could not be read.
   */
  readonly personalDataBackfill: PersonalDataBackfillLag | null | UnreadableStatus;
  /**
   * Whether this instance knows its tenant frozen with `freezeTenant`: the background work waits,
   * and the lag stays where it is, until the freeze is lifted.
   */
  readonly frozen: boolean;
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
   * The name of the store this app serves, which every store keeps the tenant's data under and
   * every port implementation's `create` receives as `tenant`. `createBoundaObject` passes the
   * Durable Object's name; leave it out for an app with one store, which then serves
   * `DEFAULT_TENANT`, the same tenant as one that names it. An empty name fails the start with
   * `ConfigurationError`.
   */
  readonly tenant?: string | undefined;
  /**
   * For tests: what `createWitness()` from `@bounda-dev/core/testing` returns, which records what
   * the app seals, keeps, logs and traces for `expectForgotten` and the other expectations. Left
   * out, the app records nothing.
   */
  readonly witness?: Witness | undefined;
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
  witness,
}: CreateAppArgs<R>): Promise<BoundaApp<R>> =>
  assembleApp<R>({ registry, config, logger, ids, clock, env, tenant, witness });

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
   * Given by `createTestApp`: with `test`, the host log goes here instead of to the registry's
   * `app/audit.ts`, and to the logger without it.
   */
  readonly onHostRejection?: OnHostRejection | undefined;
  readonly witness?: Witness | undefined;
  /**
   * Given by `createTestApp`, `false` unless the test chose `runtime.telemetry.errorText`: the
   * text of errors it makes the app log and trace is not searched.
   */
  readonly searchErrorText?: boolean;
}

const watchedClient = <R extends Registry>(
  client: BoundaClient<R>,
  witness: AppWitness,
): BoundaClient<R> => ({
  ...client,
  as: (actor) => {
    const next = watchedClient(client.as(actor), witness);
    witness.watch(next);
    return next;
  },
});

const watchedApp = <R extends Registry>(
  app: BoundaApp<R>,
  witness: AppWitness,
  adapters: readonly Adapter[],
): BoundaApp<R> => {
  const watched: BoundaApp<R> = {
    ...app,
    as: watchedClient(app, witness).as,
    stop: () => {
      witness.onStopped();
      return app.stop();
    },
  };
  witness.onApp(watched, adapters);
  return watched;
};

export interface AssembleAppFunction {
  <R extends Registry>(args: AssembleAppArgs<R>): Promise<BoundaApp<R>>;
}

export const assembleApp: AssembleAppFunction = async <R extends Registry>({
  registry,
  config: givenConfig,
  logger: givenLogger,
  ids,
  clock,
  env,
  tenant,
  test,
  pendingRetries = ignoredRetries,
  onPersonalDataAccess,
  onHostRejection,
  witness,
  searchErrorText = true,
}: AssembleAppArgs<R>): Promise<BoundaApp<R>> => {
  const tenantId = tenantIdOf(tenant);
  // Attached first, so every store call, log entry and span of the app reaches it.
  const watching =
    witness === undefined
      ? undefined
      : witnessHooksOf(witness).attach({ searchErrorText, tenant: tenantId });
  const rawConfig = watching === undefined ? givenConfig : witnessedConfig(givenConfig, watching);
  const rawLogger = watching === undefined ? givenLogger : watching.logger(givenLogger);
  const appTracer: TracerFunction =
    watching === undefined ? tracer : teedTracer(tracer, watching.tracer);
  validateRegistry(registry);
  const unkeyed = resolveConfig(rawConfig);
  checkConfigNames({ registry, config: unkeyed });
  const { errorText } = unkeyed.runtime.telemetry;
  // Told of every write a freeze refused, once the app knows of its tenant's fence.
  let fenceRefused: (error: unknown) => void = () => undefined;
  const logger = fenceAwareLogger(guardedLogger(rawLogger, errorText), (error) =>
    fenceRefused(error),
  );
  if (!isAdapter(unkeyed.storage)) {
    throw new ConfigurationError(
      `storage "${unkeyed.storage.name}" is a definition without factories. Import the adapter package's factory.`,
    );
  }
  const keySources = keySourcesOf({
    storage: unkeyed.storage,
    personalData: unkeyed.runtime.personalData,
  });
  // Built first: a master key missing from the environment fails the start before anything opens.
  const master =
    keySources.keyWrapper === null
      ? null
      : await buildKeyWrapper({ definition: keySources.keyWrapper, env });
  // Built before the storage opens and closed after it, so a `create` that fails leaves nothing
  // open; a failure further on closes them again.
  const ports = await createPorts({
    registry,
    env,
    tenant: tenantId,
    logger: guardedLogger(rawLogger, errorText, { thrownAsError: false }),
    clock,
    ...(test === undefined ? { config: unkeyed.ports } : { test }),
  });
  // What a start that fails has to close, in the order `stop` closes it.
  const opened: (() => Promise<void>)[] = [];
  try {
    // Read before the storage opens: its file, and the read models', open under the tenant's keys.
    const files = await openEncryptedFiles({
      config: rawConfig,
      master,
      tenantKeys: keySources.tenantKeys,
      tenant: tenantId,
      env,
      clock,
      logger,
    });
    // Until the key hierarchy takes it over.
    let filesStore = files.store;
    opened.push(async () => {
      await filesStore?.close?.();
    });
    const keyedConfig = files.config;
    const config = files.store === null ? unkeyed : resolveConfig(keyedConfig);
    if (!isAdapter(config.storage)) {
      throw new ConfigurationError(
        `storage "${config.storage.name}" is a definition without factories. Import the adapter package's factory.`,
      );
    }
    // The app, its clients, and every adapter it opened stand for the witness while it runs.
    const watched = (app: BoundaApp<R>): BoundaApp<R> =>
      watching === undefined
        ? app
        : watchedApp(
            app,
            watching,
            [config.storage, ...Object.values(config.readModels)].filter(isAdapter),
          );
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
        tenant: tenantId,
        keepForMs: keepForMs ?? undefined,
      });
      watching?.onForgetLedger(ledger);
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
      // Read when an intention is written, by then the watch below exists.
      reached: () => restores.reached(),
    });
    // The tenant's keys, once the key hierarchy is open: what says this instance knows it forgotten.
    let tenantKeysOpened: Pick<TenantKeys, "forgotten"> | null = null;
    const tenantForgotten = (): boolean => tenantKeysOpened?.forgotten() != null;
    const ledgerStore = forgetLedger?.store;
    // Once this instance knows the tenant forgotten, the watch writes as what settles it does.
    const forgottenCheckpoints = adapted.forgotten().checkpointStore;
    const watchedCheckpoints = (): CheckpointStore =>
      tenantForgotten() ? forgottenCheckpoints : adapted.checkpointStore;
    const restores = createRestoreWatch({
      checkpoints: {
        get: (name) => watchedCheckpoints().get(name),
        compareAndSet: (name, expected, position) =>
          watchedCheckpoints().compareAndSet(name, expected, position),
      },
      events: adapted.eventStore,
      // A forgotten tenant's start settles its database whatever copy it is, so its ledger keeps no
      // mark: one raised after the ledger was cleared would outlive it.
      marks:
        ledgerStore === undefined
          ? null
          : {
              readMark: async (name) => (tenantForgotten() ? [] : ledgerStore.readMark(name)),
              raiseMark: async (name, mark) => {
                if (!tenantForgotten()) await ledgerStore.raiseMark(name, mark);
              },
              ...(ledgerStore.pruneMarks === undefined
                ? {}
                : {
                    pruneMarks: async (name: string, before: string) => {
                      if (!tenantForgotten()) await ledgerStore.pruneMarks?.(name, before);
                    },
                  }),
              ...(ledgerStore.visibilityDelayMs === undefined
                ? {}
                : { visibilityDelayMs: ledgerStore.visibilityDelayMs }),
            },
      clock,
      logger,
    });
    const copies =
      ledgerStore === undefined
        ? null
        : createCommittedCopies({ ledger: ledgerStore, keepForMs, clock, logger });
    // Every event this instance commits is the newest the watch knows of until it reads another.
    // What it commits of a forgetting, a restriction or a redaction marks its intention in the
    // ledger committed as soon as the commit returns, ahead of the stream's copy; what the ledger
    // does not take then is appended again before each look for a restore, and at stop.
    const committed = async (events: readonly StoredEvent[]): Promise<void> => {
      for (const event of events) restores.saw(event);
      await copies?.copy(events);
    };
    // The declarations of recipients the starts on a frozen tenant could not write, as every read
    // sees them until they are: the tenant key record's once the key hierarchy is open.
    let pendingDeclarations: PendingRecipients = localPendingRecipients();
    const written = withPendingDeclarations(
      withCommittedEvents({ storage: adapted, committed }),
      () => pendingDeclarations.held(),
    );
    // What settles the tenant's forgetting, and tells its recipients after it, writes through the
    // fence of a forgotten tenant.
    const writtenForgotten = withPendingDeclarations(
      withCommittedEvents({ storage: adapted.forgotten(), committed }),
      () => pendingDeclarations.held(),
    );
    // An app whose ports tell recipients reads the head of the stream before each read that opens
    // personal data, so a disclosure can tell whether the person's stream moved since.
    const fenced = [
      ...Object.values(registry.aggregates),
      ...Object.values(registry.readModels),
    ].some((entry) => Object.keys(entry.recipients ?? {}).length > 0);
    const aggregates = buildAggregates({ registry, ports: ports.byAggregate, config });
    checkReadModelPersons({ registry, aggregates });
    checkClassification(registry);
    const processDefinitions = buildProcesses({ registry, aggregates, config });
    // The hierarchy owns the store from here, closing it when it fails.
    filesStore = null;
    const hierarchy = await openKeyHierarchy({
      storage: config.storage,
      master,
      tenantKeys: keySources.tenantKeys,
      ephemeral: keySources.ephemeral ?? false,
      opened: adapted,
      store: files.store,
      claims: files.claims,
      tenant: tenantId,
      personal:
        marksPersonalFields({ aggregates, processes: processDefinitions }) ||
        readModelsMarkPersonal(registry),
      env,
      clock,
    });
    // Closed last, after the storage, as `stop` closes them.
    if (hierarchy !== null) opened.push(hierarchy.close);
    tenantKeysOpened = hierarchy?.tenantKeys ?? null;
    if (hierarchy !== null) pendingDeclarations = recordedPendingRecipients(hierarchy.tenantKeys);
    // Writes what the record holds, `wait`ing for one another instance writes, as `storage` writes.
    const writePending = (storage: Storage, wait: boolean): Promise<boolean> =>
      writePendingRecipients({ storage, pending: pendingDeclarations, clock, wait });
    // On every pass of a tenant not frozen, whichever instance's start left them; one another
    // instance writes is left to the next.
    const settlePending = async (): Promise<void> => {
      try {
        await writePending(adapted, false);
      } catch (error) {
        logger.error("the declarations of recipients the freeze held could not be written yet", {
          error,
        });
      }
    };
    // The fence each database of the tenant holds, the read models' once they are built.
    const fencedDatabases: Pick<Storage, "fence">[] = [adapted];
    const freezeKeeper = createFreezeKeeper({
      tenant: tenantId,
      stores: () => fencedDatabases,
      record: async () => {
        if (hierarchy === null) return null;
        await hierarchy.tenantKeys.refresh();
        return hierarchy.tenantKeys.frozenAt();
      },
      clock,
      logger,
    });
    await freezeKeeper.keep();
    // A tenant frozen when the app starts: what the start writes waits for the freeze to lift, and
    // the background work with it.
    const frozenAtStart = (await adapted.fence.read()).state === "frozen";
    const fences = createFenceWatch({ storage: adapted, clock, logger, frozen: frozenAtStart });
    fenceRefused = fences.refused;
    const deferred: (() => Promise<void>)[] = [];
    const unlessFrozen = async (step: () => Promise<void>): Promise<void> => {
      if (frozenAtStart) deferred.push(step);
      else await step();
    };
    // Each in turn, kept until it went through: one that fails is logged and tried again on the
    // next pass, which goes on meanwhile.
    const settleDeferred = async (): Promise<void> => {
      for (let step = deferred[0]; step !== undefined; step = deferred[0]) {
        try {
          await step();
        } catch (error) {
          logger.error("what the start left for the tenant to thaw could not be done yet", {
            error,
          });
          return;
        }
        deferred.shift();
      }
    };
    const keyed = hierarchy?.wrapping ?? keylessWrapping();
    const wrapping = watching === undefined ? keyed : witnessedWrapping(keyed, watching);
    // Opened at once, never inside a transaction: none of a forgotten tenant, whose key is gone.
    const databaseKey =
      hierarchy === null || hierarchy.tenantKeys.forgotten() !== null
        ? null
        : await openDatabaseKey({ store: written.indexKeys, wrapping, clock });
    const storage = appStorage({
      storage: written,
      aggregates,
      processes: processDefinitions,
      wrapping,
      fenced,
      atRest: databaseKey?.atRest ?? null,
    });
    const loader = createAggregateLoader({
      snapshotStore: storage.snapshotStore,
      logger,
      strict: test !== undefined,
      fenced,
    });
    const readModels = await buildReadModels({ registry, config, logger });
    opened.unshift(() => readModels.close());
    fencedDatabases.push(...Object.values(readModels.byName).map(({ storage: own }) => own));
    await freezeKeeper.keep();
    logClearFields({ readModels: readModels.byName, config, encrypted: files.encrypted, logger });
    const fileEncryptions = createFileEncryptions({ config, clock, logger });
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
    // One list per `runUntilIdle` under way.
    const observers = new Set<CommandRejection[]>();
    const recordAccess = createAccessLog({
      hook: test === undefined ? registry.audit?.onPersonalDataAccess : onPersonalDataAccess,
      env,
      tenant: tenantId,
      logger,
      clock,
    });
    const recordRejection = createHostLog({
      hook: test === undefined ? registry.audit?.onHostRejection : onHostRejection,
      env,
      logger,
      clock,
    });
    const recipients = buildRecipients({ registry, categories: personalCategories, ports });
    const transfers = storeTransfers({
      config,
      personal: (name) => (readModels.byName[name]?.layout.personal.length ?? 0) > 0,
    });
    const returns = buildPortReturns({ registry, categories: personalCategories });
    const returningPorts = portsByCategory(returns);
    const notices = createRecipientNotices({
      tracer: appTracer,
      recipients,
      storage,
      config,
      clock,
      recordAccess,
      returns,
    });
    const delivery = createRecipientDelivery({
      recipients,
      notices,
      storage,
      config,
      clock,
      pendingRetries,
      logger,
    });
    const { concurrencyRetries } = config.runtime.commands;
    const forgottenError = (): TenantForgottenError =>
      new TenantForgottenError(
        tenantId,
        hierarchy?.tenantKeys.forgotten()?.at ?? clock.now().toISOString(),
      );
    // Each with whether its rows may keep something derived from personal data, as its view says.
    const everyReadModel = Object.values(readModels.byName).map(({ name, storage: own }) => ({
      name,
      storage: own,
      personal: registry.readModels[name]?.view.holdsPersonalData !== false,
    }));
    // The declarations of recipients the starts on a frozen tenant left are among its recipients
    // when it is forgotten, and written with the forgetting, whose fence lets them through.
    const settleTenantForgettingWith: typeof settleTenantForgetting = async (args) => {
      await pendingDeclarations.refresh();
      await settleTenantForgetting(args);
      await writePending(adapted.forgotten(), true);
    };
    const settleForgotten = (
      forgetting: NonNullable<ReturnType<NonNullable<typeof hierarchy>["tenantKeys"]["forgotten"]>>,
      {
        actor,
        mayBeCopy = true,
      }: { readonly actor?: string | undefined; readonly mayBeCopy?: boolean } = {},
    ): Promise<void> =>
      settleTenantForgettingWith({
        storage: writtenForgotten,
        readModels: everyReadModel,
        tenant: tenantId,
        forgetting,
        ledger: forgetLedger?.store ?? null,
        mayBeCopy,
        ports: recipients.all.map(({ port, categories }) => ({ port, categories })),
        ids,
        clock,
        logger,
        concurrencyRetries,
        context: startedBy(ids.next(), actor),
      });
    const forgottenLedger =
      forgetLedger === null
        ? null
        : createForgottenLedger({
            ledger: forgetLedger.store,
            keepForMs,
            reconcileEveryMs: forgetLedger.config.reconcileEveryMs,
            tenant: tenantId,
            logger,
          });
    const forgottenRunnerOf = (keys: NonNullable<typeof hierarchy>): ForgottenRunner => {
      const told = {
        ...appStorage({
          storage: writtenForgotten,
          aggregates,
          processes: processDefinitions,
          wrapping,
          fenced,
          atRest: null,
        }),
        // Its events as stored: the notices read no personal field, and a copy restored under the
        // app holds keys whose tenant's key is gone, which opening would refuse.
        eventStore: writtenForgotten.eventStore,
      };
      const toldNotices = createRecipientNotices({
        tracer: appTracer,
        recipients,
        storage: told,
        config,
        clock,
        recordAccess,
        returns,
      });
      return createForgottenRunner({
        tracer: appTracer,
        storage: told,
        config,
        notices: toldNotices,
        delivery: createRecipientDelivery({
          recipients,
          notices: toldNotices,
          storage: told,
          config,
          clock,
          pendingRetries,
          logger,
        }),
        recordAccess,
        restores,
        tenantKeys: keys.tenantKeys,
        forgotten: forgottenError,
        resettle: async () => {
          const forgetting = keys.tenantKeys.forgotten();
          if (forgetting !== null) await settleForgotten(forgetting);
        },
        lowered: async () => {
          for (const store of fencedDatabases) {
            if ((await store.fence.read()).state !== "forgotten") return true;
          }
          return false;
        },
        discharge: async () => {
          if (await keys.tenantKeys.releaseFiles()) {
            logger.warn(
              "tenant forgotten: its recipients are told, and its database files' keys destroyed",
              { tenant: tenantId },
            );
          }
          const forgetting = keys.tenantKeys.forgotten();
          // Before the storage is emptied, which a later discharge would find gone.
          if (forgottenLedger !== null && forgetting !== null) {
            const again = await forgottenLedger.clear(forgetting, clock.now());
            if (again !== null) return again;
          }
          // Only a database that holds more than the forgetting's own event: one emptied already
          // holds that alone, appended again when it opened.
          if (adapted.discard === undefined) return null;
          const held = await adapted.eventStore.readAll({ afterPosition: 0, limit: 2 });
          if (held.some(({ id }) => id !== forgetting?.eventId)) {
            await adapted.discard();
            logger.warn("tenant forgotten: its recipients are told, and its storage emptied", {
              tenant: tenantId,
            });
          }
          return null;
        },
        retain: async (now) => {
          await forgottenLedger?.retain(now);
        },
        ledgerCleared: async () => (forgottenLedger === null ? null : forgottenLedger.cleared()),
        // Read again, as another instance may have destroyed them.
        fileKeysDestroyed: async () => (await keys.tenantKeys.refresh())?.files === undefined,
        pendingRetries,
        ids,
        clock,
        logger,
        errorText,
      });
    };
    const forgottenAtStart = hierarchy?.tenantKeys.forgotten() ?? null;
    if (hierarchy !== null && forgottenAtStart !== null) {
      await settleForgotten(forgottenAtStart);
      logger.warn("tenant forgotten: the app serves nothing but the notices to its recipients", {
        tenant: tenantId,
        forgottenAt: forgottenAtStart.at,
      });
      return watched(
        forgottenApp<R>({
          config,
          role: config.runtime.role,
          runner: forgottenRunnerOf(hierarchy),
          forgotten: forgottenError,
          forgetting: forgottenAtStart,
          tenant: tenantId,
          recordRejection,
          close: async () => {
            await copies?.retry();
            await restores.flush();
            try {
              for (const close of opened) await close();
            } finally {
              await ports.dispose();
            }
          },
        }),
      );
    }
    const sealing = await openReadModelSealing({
      layouts: Object.values(readModels.byName).map(({ layout }) => layout),
      keys: storage.personalKeys,
      databaseKey,
      scheduler: written.scheduler,
    });
    await unlessFrozen(() =>
      settleReadModels({ readModels: Object.values(readModels.byName), sealing, logger }),
    );
    // What was disclosed under a port's former key is the renamed port's, presumption included.
    const declaration: Omit<PendingRecipientDeclaration, "id"> = {
      renames: recipients.all.flatMap(({ port, formerly }) =>
        formerly.map((from) => ({ from, to: port })),
      ),
      ports: recipients.all.map(({ port, categories }) => ({ port, categories })),
      position: await written.eventStore.lastPosition(),
      at: clock.now().toISOString(),
    };
    // A frozen tenant's wait in the record, read as written by every instance until the thaw
    // writes them; one forgotten meanwhile has no recipient to declare any more. Those left by
    // earlier starts are written before this one's, so none overwrites a later declaration.
    let declaredRecipients: readonly DeclaredRecipient[];
    if (frozenAtStart) {
      await pendingDeclarations.add({ id: ids.next(), ...declaration }).catch((error: unknown) => {
        if (!(error instanceof TenantForgottenError)) throw error;
      });
      // A thaw that lowered the fence meanwhile writes no declaration added after it.
      if ((await adapted.fence.read()).state === "open") await writePending(adapted, true);
      declaredRecipients = await written.recipients.declared();
    } else {
      await writePending(adapted, true);
      declaredRecipients = await writeDeclaration(written.recipients, declaration);
    }
    for (const { port, persons } of await written.recipients.summary()) {
      if (recipients.byPort[port] === undefined) {
        logger.warn(
          "a recipient holds personal data and its port is not declared: what it is told of goes to dead letters",
          { recipient: port, persons },
        );
      }
    }
    const disclosures =
      recipients.all.length === 0
        ? undefined
        : createDisclosures({ recipients, storage, intentions, recordAccess, clock });
    const marks = marksFingerprint({ aggregates, processes: processDefinitions });
    const earlierAnswers = createEarlierAnswers({ storage, atRest: storage.atRest, clock });
    const pipeline = createCommandPipeline({
      tracer: appTracer,
      aggregates,
      loader,
      storage,
      config,
      ids,
      clock,
      logger,
      recordAccess,
      disclosures,
      returns,
      marks,
      earlierAnswers,
      onRejection: (rejection) => {
        for (const observed of observers) observed.push(rejection);
      },
    });
    const queryRunner = createQueryRunner({
      tracer: appTracer,
      queries: buildQueries({ readModels }),
      readModels,
      sealing,
      ports: ports.byReadModel,
      recordAccess,
      errorText,
      disclosures,
      returns,
      persons: storage.persons,
      // The dispatcher is built further down; a query only asks once the app is assembled.
      standing: (subscriber) => dispatcher.positionOf(subscriber),
      vouch: {
        before: (readModel) => vouchBefore(readModel),
        after: (readModel) => vouchAfter(readModel),
      },
    });
    const processes = createProcessRunner({
      tracer: appTracer,
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
      disclosures,
      returns,
    });
    const policies = buildPolicies({ registry, aggregates });
    const policyExecutor = createPolicyExecutor({
      tracer: appTracer,
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
      disclosures,
      returns,
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
      // Kept while the store remembers any recipient, declared or not: what a port removed is told
      // of still reaches its dead letters.
      {
        subscriber: createRecipientSubscriber({ recipients, delivery, storage }),
        following: declaredRecipients.length > 0,
      },
    ];
    const following = reactive.filter((entry) => entry.following).map((entry) => entry.subscriber);
    const retries = createDeadLetterRetry({
      storage,
      pipeline,
      aggregates,
      policies,
      policyExecutor,
      processes,
      notices,
      config,
      ids,
      clock,
    });
    // Read now: a frozen tenant's head stays where it is until the thaw, whose writes come after.
    const head = await storage.eventStore.lastPosition();
    await unlessFrozen(() =>
      alignReactiveCheckpoints({
        head,
        checkpointStore: storage.checkpointStore,
        following: following.map((subscriber) => subscriber.name),
      }),
    );
    // Without a retention the sweep still ends what a forgetting kept that no erasure exemption
    // keeps any more, which only an app that marks personal fields can hold.
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
    const handlersOf: Readonly<Record<DeadLetterKind, Readonly<Record<string, unknown>>>> = {
      policy: policies.byName,
      process: processDefinitions.byName,
      scheduled: aggregates.commandsByType,
      recipient: recipients.byPort,
    };
    const letterRetention = createDeadLetterRetention({
      store: written.deadLetterStore,
      checkpoints: written.checkpointStore,
      persons: storage.persons,
      keys: storage.personalKeys,
      // A kind no release writes, cast by a store, has no handler.
      handles: (kind, handler) => handlersOf[kind]?.[handler] !== undefined,
      retentionMs: config.runtime.deadLetters.retentionMs,
      clock,
      logger,
    });
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
      onRedacted: watching?.onRedacted,
    };
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
    const reseal =
      hierarchy === null
        ? undefined
        : createPersonalDataReseal({
            storage: written,
            wrapping,
            tenantKeys: hierarchy.tenantKeys,
            databaseKey,
            readModels: createResealReadModels({
              readModels: Object.values(readModels.byName),
              rebuild: (name, options) => rebuild(name, options),
              maxEvents: config.runtime.dispatcher.batchSize * REDACTION_REBUILD_BATCHES,
            }),
            batchSize: config.runtime.dispatcher.batchSize,
            clock,
            logger,
          });
    const rotation =
      hierarchy === null
        ? undefined
        : createKeyRotation({
            keys: written.personalKeys,
            indexKeys: written.indexKeys,
            checkpoints: written.checkpointStore,
            tenantKeys: hierarchy.tenantKeys,
            master: hierarchy.master,
            wrapping,
            reseal,
            clock,
            logger,
          });
    const walked = walkFingerprint({ aggregates, processes: processDefinitions });
    const backfill =
      walked === null || marks === null
        ? undefined
        : createPersonalDataBackfill({
            tracer: appTracer,
            storage: written,
            reading: storage.eventStore,
            atRest: storage.atRest,
            aggregates,
            processes: processDefinitions,
            wrapping,
            marks: walked,
            answerMarks: marks,
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
      // Without a ledger, the disclosures the copy lost are gone: every recipient may hold what
      // existed up to now, and is told as such.
      if (forgetLedger === null) {
        await written.recipients.presumeThrough(await written.eventStore.lastPosition());
      }
      const forgotten = await reconciliation?.reconcile(clock.now());
      await restores.settled();
      return typeof forgotten === "number" ? forgotten : 0;
    };
    // Committed entries the ledger holds and the database lost, which a reconciliation applied
    // again while no restore was known: the database went back unseen, a restore counted once.
    // An intention whose commit never came is applied again as asked, and is no restore.
    const declareUndone = async (): Promise<void> => {
      if (reconciliation === undefined) return;
      const undone = reconciliation.undone();
      if (undone === 0) return;
      await worker.restored(
        await restores.declare({ reconciled: true, past: reconciliation.past() }),
        { reconciled: true },
      );
      reconciliation.declared(undone);
      await restores.settled();
    };
    // The databases that hold read models and not the stream, each restored apart from it.
    const readModelAdapter = (name: string) => adapterForReadModel({ name, config });
    const ownDatabase = (name: string): boolean => readModelAdapter(name) !== config.storage;
    const hosts = restrictedPersonsHosts({
      readModels: Object.values(readModels.byName),
      adapterOf: readModelAdapter,
    });
    const readModelDatabases = createReadModelDatabases({
      databases: watchedDatabasesOf({
        readModels: Object.values(readModels.byName),
        hosts,
        adapterOf: readModelAdapter,
        storage: config.storage,
        logger,
      }),
      events: written.eventStore,
      reached: written.checkpointStore,
      logger,
    });
    // A restore this instance found, until the forget ledger is reconciled with it: a strict app
    // hands out nothing it reads meanwhile.
    let unreconciled: { readonly cause?: unknown } | null = null;
    const strict = forgetLedger?.config.strict === true;
    let settling: Promise<unknown> | null = null;
    // What a read hands out is vouched for: a read model of a database not back where it stood is
    // refused, and a strict app checks after every read, the newest event seen included, that the
    // database did not go back meanwhile and that the ledger is reconciled with any restore found.
    const vouchBefore = async (...names: readonly string[]): Promise<void> => {
      for (const name of names) await readModelDatabases.vouch(name);
    };
    const readModelNames = Object.keys(readModels.byName);
    // A restore is settled once the ledger is reconciled with it and the read models projected
    // what that committed again; what was read before then is refused.
    const settleRestore = async (): Promise<void> => {
      // A strict app has a ledger.
      const result = await (reconciliation as ForgetLedgerReconciliation).reconcile(clock.now());
      if (typeof result === "number") {
        await dispatcher.catchUp("projection");
        unreconciled = null;
      } else unreconciled = { cause: result.failed };
    };
    const vouchAfter = async (...names: readonly string[]): Promise<void> => {
      if (!strict) return;
      const found = await restores.check(clock.now());
      // Finding it marks it unreconciled, as every restore this instance learns of.
      if (found !== null) await restartFound(found);
      if (unreconciled !== null) {
        settling ??= settleRestore().finally(() => {
          settling = null;
        });
        await settling;
        throw new RestoreUnreconciledError(unreconciled?.cause);
      }
      for (const name of names) await readModelDatabases.vouch(name, { fresh: true });
    };
    // A pass checks first whether the tenant was forgotten elsewhere, once the check exists.
    let tenantCheck: () => Promise<void> = async () => undefined;
    const subscribers = [
      ...Object.values(readModels.byName).map((readModel) =>
        createProjectionSubscriber({
          tracer: appTracer,
          readModel,
          sealing,
          logger,
          errorText,
          budget: { clock, maxMs: config.runtime.dispatcher.projectionBatchTimeMs },
          marked: ownDatabase(readModel.name),
        }),
      ),
      ...hosts.map((readModel) =>
        createRestrictedPersonsSubscriber({
          tracer: appTracer,
          readModel,
          logger,
          errorText,
          marked: ownDatabase(readModel.name),
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
      ...(recordsActivity
        ? [createRetentionSubscriber({ persons: storage.persons, keys: storage.personalKeys })]
        : []),
      ...(forgetLedger === null
        ? []
        : [createLedgerOutbox({ ledger: forgetLedger.store, keepForMs, clock })]),
    ];
    const failureRetention = createSubscriberFailureRetention({
      store: written.subscriberFailures,
      persons: storage.persons,
      keys: storage.personalKeys,
      subscribers: subscribers.map(({ name }) => name),
      retentionMs: config.runtime.subscriberFailures.retentionMs,
      clock,
      logger,
    });
    const dispatcher = createDispatcher({
      tracer: appTracer,
      eventStore: storage.eventStore,
      checkpointStore: storage.checkpointStore,
      subscribers,
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
        await tenantCheck();
        await freezeKeeper.keep();
        await fences.check();
        if (fences.frozen()) return;
        await settleDeferred();
        await settlePending();
        await fileEncryptions.settle();
        await copies?.retry();
        const found = await restores.check(clock.now());
        if (found !== null) await restartFound(found);
        // A read model's database restored apart from the stream is projected back before it serves.
        await readModelDatabases.check();
      },
      paused: fences.frozen,
      refused: fences.refused,
      clock,
      logger,
      errorText,
    });
    const worker = createScheduledCommandWorker({
      tracer: appTracer,
      storage,
      paused: fences.frozen,
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
      failureRetention,
      rotation,
      reseal,
      reconciliation,
      intentions,
      backfill,
      recipientCatchUp: createRecipientCatchUp({
        recipients,
        delivery,
        storage: written,
        batchSize: config.runtime.dispatcher.batchSize,
      }),
      redactionScrubs: {
        advance: async ({ position, types }) => {
          for (const { name, storage: own, layout, projectionsByEvent } of Object.values(
            readModels.byName,
          )) {
            // A read model whose view states it holds no personal data is taken at its word.
            if (registry.readModels[name]?.view.holdsPersonalData === false) continue;
            const personal = layout.personal.length > 0;
            const derives = types.some((type) => (projectionsByEvent[type]?.length ?? 0) > 0);
            if (!personal && !derives) continue;
            const checkpoints = await own.checkpointStore.list();
            const at = (subscriber: string): number =>
              checkpoints.find((checkpoint) => checkpoint.subscriber === subscriber)?.position ??
              -1;
            // The live table hides the person's values once it projected the redaction.
            if (personal && at(projectionSubscriberName(name)) < position) return "waiting";
            if (!derives) {
              if (!rebuildsPassed({ checkpoints, name, position })) return "waiting";
              continue;
            }
            if (at(rebuiltMark(name)) >= position) continue;
            // A rebuild under way that started before the redaction hides the person's values in its
            // shadow as it projects it, and another one follows it.
            try {
              await rebuild(name, {
                maxEvents: config.runtime.dispatcher.batchSize * REDACTION_REBUILD_BATCHES,
              });
            } catch (error) {
              // Another instance's slice, or a rebuild run by hand, took over and goes on.
              if (!(error instanceof RebuildSupersededError)) throw error;
            }
            return "progressed";
          }
          return "ready";
        },
        settle: (entry) =>
          settleRedaction({
            redactions,
            entry,
            batchSize: config.runtime.dispatcher.batchSize,
          }),
      },
      restores,
      onRestored: async () => {
        dispatcher.restored();
        earlierAnswers.reset();
        readModelDatabases.restored();
        unreconciled = {};
        // A copy from before a reseal holds the database's keys of then, not those this instance
        // read since.
        await databaseKey?.refresh().catch((error: unknown) => {
          logger.error("the database's key could not be read again", { error });
        });
      },
      reactive: following.map((subscriber) => subscriber.name),
      standing: dispatcher.positionOf,
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
      // A subscriber whose checkpoint cannot be read is logged and left out, not the others.
      const current = await dispatcher.standings();
      for (const subscriber of current.subscribers) {
        if ("unreadable" in subscriber) continue;
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
        letterRetention.nextDueAt(),
        failureRetention.nextDueAt(),
        rotation?.nextDueAt() ?? null,
        reseal?.nextDueAt() ?? null,
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
    // What this instance knows of its own, beside what the dispatcher reads.
    const known = (): Pick<AppLag, "waitingDeadlines" | "forgetLedger"> => ({
      waitingDeadlines: worker.waitingDeadlines(),
      forgetLedger:
        reconciliation === undefined ? null : { reconciled: reconciliation.reconciled() },
    });
    const backfilled = async (): Promise<AppLag["personalDataBackfill"]> => {
      if (backfill === undefined) return null;
      try {
        return await backfill.status();
      } catch (error) {
        logger.error("the personal data backfill could not be read", { error });
        return { unreadable: true };
      }
    };
    const getLag = async (): Promise<AppLag> => {
      const [standings, personalDataBackfill] = await Promise.all([
        dispatcher.standings(),
        backfilled(),
      ]);
      return { ...standings, ...known(), personalDataBackfill, frozen: fences.frozen() };
    };
    const status = (): Promise<AppStatus> =>
      readAppStatus({
        config,
        logger,
        lag: async () => ({ ...(await dispatcher.standings()), ...known() }),
        backfill: backfill === undefined ? undefined : () => backfill.status(),
        failures: written.subscriberFailures,
        restores,
        reconciliation,
        rotation,
        tenant: hierarchy === null ? undefined : () => hierarchy.tenantKeys.status(),
        retention,
        letterRetention,
        failureRetention,
        // A record that does not answer is the tenant's status to report: the declarations are
        // read as it held them last.
        recipients: async () => {
          await pendingDeclarations.refresh().catch(() => undefined);
          return recipientStatuses({ storage: written, recipients });
        },
        frozenTenant: async () => {
          const fence = await adapted.fence.read();
          if (fence.state !== "frozen") return null;
          return { frozenAt: fence.since, whole: (await whollyFrozen(fencedStores)) !== null };
        },
      });
    // A copy restored while the app was stopped holds less than the forget ledger's mark: the
    // holds it brought back are cleared before anything runs, and the reconciliation below forgets
    // again whom it brought back.
    const startRestores = async (): Promise<void> => {
      const found = await restores.start();
      if (found !== null) await worker.restored(found);
    };
    // A frozen tenant compares its database with the ledger once it thaws, as a start does.
    if (frozenAtStart) {
      // Run before a pass of the dispatcher, which then projects what it committed again.
      deferred.push(async () => {
        await startRestores();
        await reconciliation?.reconcile(clock.now());
        await restores.settled();
        // A step of its own, right after this one, so a declaration that fails is made again
        // alone.
        deferred.splice(1, 0, declareUndone);
      });
    } else await startRestores();
    // An instance that runs no worker still watches for a restore, and reconciles the ledger at
    // once when it finds one, since no pass of its own would.
    const watchForRestores = (): (() => void) => {
      let cancel: () => void = () => undefined;
      // A look under way when the watch stops arms no other.
      let stopped = false;
      const next = (): void => {
        if (stopped) return;
        cancel = clock.after(GENERATION_INTERVAL_MS, async () => {
          try {
            // It waits while the tenant is frozen, as a worker does, and once it thaws does first
            // what the start left for then.
            await freezeKeeper.keep();
            await fences.check();
            if (!fences.frozen()) {
              await settleDeferred();
              await settlePending();
              await copies?.retry();
              const found = await restores.check(clock.now());
              if (found !== null && (await restartFound(found)) > 0) {
                await dispatcher.catchUp("projection");
              }
              await readModelDatabases.check();
            }
          } catch (error) {
            logger.error("the watch for a restore failed; it looks again later", { error });
          } finally {
            next();
          }
        });
      };
      next();
      return () => {
        stopped = true;
        cancel();
      };
    };
    let unwatch: (() => void) | undefined;
    // Before the app serves anything: a backup restored brings back persons forgotten since, and
    // the read models that show them hear of it by the time the start resolves. A ledger that
    // does not answer in time is left to finish behind the start, as one that fails is retried,
    // unless the ledger is strict, whose start waits and fails with it.
    if (reconciling !== null && !frozenAtStart) {
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
      } else {
        // The ledger held a committed entry the database lacks, or one written where the database
        // had gone further than it stands: a restore, whatever the mark said.
        await declareUndone();
        if (forgotten > 0) await dispatcher.catchUp("projection");
      }
      // Reconciled, or the start failed already.
      unreconciled = null;
    }
    // Nor before a read model whose database of its own was restored apart from the stream is back
    // where it stood, or projected again from the start when it holds what another stream wrote.
    // A frozen tenant's are compared all the same, and one not back serves nothing until the
    // tenant thaws and the passes, which check before each, catch it up.
    const served = await readModelDatabases.check();
    if (!frozenAtStart) {
      if (!served) {
        await dispatcher.catchUp("projection");
        await readModelDatabases.check();
      }
      await restores.settled();
    }
    const rebuild = (
      name: string,
      options: RebuildReadModelOptions & { readonly actor?: string } = {},
    ) =>
      rebuildReadModelWith({
        tracer: appTracer,
        registry,
        config: keyedConfig,
        name,
        logger,
        wrapping,
        ...options,
      });
    const keysFor = (operation: string): NonNullable<typeof hierarchy> => {
      if (hierarchy === null) {
        throw new ConfigurationError(
          `${operation} needs keys: set runtime.personalData.keyWrapper and runtime.personalData.tenantKeys`,
        );
      }
      return hierarchy;
    };
    // What this instance runs once it knows the tenant is forgotten, built once.
    let forgottenRunner: ForgottenRunner | null = null;
    let entering: Promise<ForgottenRunner> | null = null;
    let started = false;
    // A failure is logged and forgotten, so the next call that finds the tenant forgotten tries
    // again; `settled` when the caller settled the forgetting itself.
    const enterForgotten = (
      keys: NonNullable<typeof hierarchy>,
      { settled = false } = {},
    ): Promise<ForgottenRunner> => {
      if (entering !== null) return entering;
      const entered: Promise<ForgottenRunner> = (async () => {
        unwatch?.();
        unwatch = undefined;
        await Promise.all([dispatcher.stop(), worker.stop()]);
        if (!settled) {
          const forgetting = keys.tenantKeys.forgotten() ?? (await keys.tenantKeys.refresh());
          if (forgetting !== null) await settleForgotten(forgetting);
        }
        wrapping.close();
        const runner = forgottenRunnerOf(keys);
        forgottenRunner = runner;
        if (started && stopping === undefined) runner.start();
        return runner;
      })().catch((error: unknown) => {
        if (entering === entered) entering = null;
        logger.error("the tenant's forgetting could not be settled", { tenant: tenantId, error });
        throw error;
      });
      entering = entered;
      return entered;
    };
    const enterQuietly = (keys: NonNullable<typeof hierarchy>): void => {
      enterForgotten(keys).catch(() => undefined);
    };
    // Whether the tenant was forgotten, read from the database's binding at most once every
    // `TENANT_CHECK_INTERVAL_MS`: another instance's forgetting is seen within that time.
    let checkedAt = Number.NEGATIVE_INFINITY;
    const ensureLive = async (): Promise<void> => {
      if (hierarchy === null) return;
      if (entering !== null) throw forgottenError();
      const now = clock.now().getTime();
      if (now >= checkedAt && now - checkedAt < TENANT_CHECK_INTERVAL_MS) return;
      checkedAt = now;
      const binding = await written.tenancy.get();
      if (hierarchy.tenantKeys.forgotten() !== null || binding?.forgottenAt != null) {
        // Read again, so the error names when the tenant was forgotten, not now.
        if (hierarchy.tenantKeys.forgotten() === null) {
          await hierarchy.tenantKeys.refresh().catch(() => null);
        }
        enterQuietly(hierarchy);
        throw forgottenError();
      }
    };
    tenantCheck = ensureLive;
    // What a call that ran into the tenant's forgetting does, as another instance's makes a key
    // operation throw: enters it here too.
    const onTenantForgotten = (): void => {
      if (hierarchy !== null) enterQuietly(hierarchy);
    };
    const guarded: <T>(value: T) => T =
      hierarchy === null
        ? (value) => value
        : guardClient({ ensureLive, onForgotten: onTenantForgotten });
    const forgetThisTenant = async (
      name: string,
      { despiteLegalObligations = false }: ForgetTenantOptions = {},
      actor?: string,
    ): Promise<TenantForgottenResult> => {
      const keys = keysFor("forgetTenant");
      if (name !== tenantId) {
        throw runtimeText(
          new ValidationError(`forgetTenant names tenant ${name}, and the app serves another`, [
            { path: ["tenant"], message: "Expected the tenant the app serves" },
          ]),
        );
      }
      const earlier = keys.tenantKeys.forgotten();
      if (earlier === null) {
        const held = (await written.personalKeys.categories()).filter(
          (category) => personalCategories.of(category)?.basis === "legal-obligation",
        );
        if (held.length > 0 && !despiteLegalObligations) {
          throw runtimeText(
            new ValidationError(
              `Tenant ${tenantId}'s persons hold keys a legal obligation keeps (${held.join(", ")}): hand the data back first, then forget the tenant with despiteLegalObligations`,
              [{ path: ["despiteLegalObligations"], message: "Expected true to destroy them too" }],
            ),
          );
        }
      }
      if (earlier === null) await fileEncryptions.refuseClear();
      const forgetting =
        earlier ??
        (await keys.tenantKeys.forget({ at: clock.now().toISOString(), eventId: ids.next() }));
      await settleForgotten(forgetting, { actor, mayBeCopy: earlier !== null });
      if (earlier === null) {
        logger.warn("tenant forgotten", { tenant: tenantId, eventId: forgetting.eventId });
      }
      await enterForgotten(keys, { settled: true });
      return { tenant: tenantId, forgottenAt: forgetting.at, eventId: forgetting.eventId };
    };
    const fencedStores: FencedStores = {
      tenant: tenantId,
      storage: adapted,
      readModels: Object.values(readModels.byName),
      ledger: forgetLedger?.store ?? null,
      tenantKeys: hierarchy?.tenantKeys ?? null,
    };
    const named = (operation: string, name: string): void => {
      if (name === tenantId) return;
      throw runtimeText(
        new ValidationError(`${operation} names tenant ${name}, and the app serves another`, [
          { path: ["tenant"], message: "Expected the tenant the app serves" },
        ]),
      );
    };
    const freezeThisTenant = async (name: string): Promise<TenantFrozenResult> => {
      named("freezeTenant", name);
      // A copy restored under the app is settled while the tenant still takes what settles it.
      const found = await restores.check(clock.now());
      if (found !== null) {
        await restartFound(found);
        if (strict) await settleRestore();
      }
      const frozen = await freezeStores({
        ...fencedStores,
        clock,
        drain: async () => {
          const forgotten = (await reconciliation?.drain(clock.now())) ?? 0;
          if (forgotten > 0)
            logger.warn("committed before the freeze what the forget ledger held", { forgotten });
          await declareUndone();
        },
      });
      freezeKeeper.recorded(frozen.frozenAt);
      await fences.check({ now: true });
      logger.warn("tenant frozen: it takes no write until unfrozen", {
        tenant: tenantId,
        frozenAt: frozen.frozenAt,
      });
      return frozen;
    };
    const unfreezeThisTenant = async (name: string): Promise<void> => {
      named("unfreezeTenant", name);
      await unfreezeStores(fencedStores);
      freezeKeeper.recorded(null);
      await fences.check({ now: true });
      // The thaw writes what the starts the freeze held declared, before it resolves.
      await pendingDeclarations.refresh();
      await writePending(adapted, true);
    };
    const rotateTenantKey = async ({
      reseal: resealing = false,
    }: RotateTenantKeyOptions = {}): Promise<TenantKeyVersions> => {
      const { tenantKeys } = keysFor("rotateTenantKey");
      // A rotation would rewrap the keys a reseal still replaces; another reseal waits for the
      // previous one to end altogether.
      if (resealing && reseal !== undefined && (await reseal.active())) {
        throw runtimeText(
          new ValidationError(
            "A reseal of the tenant's personal data is under way: another one can start once it is complete",
            [{ path: ["reseal"], message: "Expected no reseal under way" }],
          ),
        );
      }
      if (reseal !== undefined && (await reseal.holdsSuperseded())) {
        throw runtimeText(
          new ValidationError(
            "A reseal keeps the persons' keys it replaced: the tenant's key rotates again once it destroys them",
            [{ path: [], message: "Expected no reseal keeping keys" }],
          ),
        );
      }
      // Begun before the rotation, so the worker never rewraps a key the reseal replaces.
      if (resealing) await reseal?.begin();
      await tenantKeys.rotate();
      // Each file has a new key too, which the worker moves it under once it can.
      await fileEncryptions.refresh();
      if (resealing) await reseal?.switchDatabaseKey();
      const versions = await tenantKeys.kids();
      logger.info(
        resealing
          ? "tenant key rotated; every key that seals personal data is replaced in the background"
          : "tenant key rotated",
        {
          tenant: tenantId,
          ...versions,
        },
      );
      return versions;
    };
    const retireTenantKeys = async (): Promise<readonly string[]> => {
      const { tenantKeys } = keysFor("retireTenantKeys");
      const { previous, since } = await tenantKeys.kids();
      if (previous.length === 0) return [];
      if (reseal !== undefined && (await reseal.holdsSuperseded())) {
        throw runtimeText(
          new ValidationError(
            "A reseal keeps the persons' keys it replaced, wrapped under an older version of the tenant's key: wait for it to destroy them",
            [{ path: [], message: "Expected no reseal keeping keys" }],
          ),
        );
      }
      // An instance that read the tenant's record before the rotation wraps new keys under the
      // older version until it reads it again, which it does within the key cache's time.
      if (clock.now().getTime() - Date.parse(since) < 2 * UNWRAPPED_KEY_TTL_MS) {
        throw runtimeText(
          new ValidationError(
            `The version of the tenant's key in force was created at ${since}: older versions can be retired once every instance wraps under it, twice the key cache's time after`,
            [{ path: [], message: "Expected the version in force to be older" }],
          ),
        );
      }
      if (rotation !== undefined && !(await rotation.settled())) {
        throw runtimeText(
          new ValidationError(
            "Keys are still wrapped under an older version of the tenant's key: wait for the rotation to finish",
            [{ path: [], message: "Expected no key under an older version" }],
          ),
        );
      }
      const retired = await tenantKeys.retire();
      logger.info("older versions of the tenant key retired", { tenant: tenantId, retired });
      return retired;
    };
    const clientAs = (
      actor: string | undefined,
    ): BoundaClient<R> & { readonly deadLetters: DeadLetters } => {
      const streamAs = async (
        personId: string,
        options: PersonalDataExportOptions = {},
      ): Promise<AsyncIterable<PersonalDataExportPart>> => {
        const includeWithheld = options.includeWithheld === true;
        const exportId = ids.next();
        let others: () => readonly string[] = () => [];
        const record = (outcome: ExportOutcome, error: unknown, counts = NO_EXPORTED_RECORDS) =>
          recordAccess({
            operation: "exportPersonalData",
            detail: { exportId, ...counts, includeWithheld },
            actor,
            persons: isPersonId(personId) ? [personId, ...others()] : [],
            outcome,
            error,
          });
        // A person id that is none, or a read model not served, refuses the export before it reads.
        await checked(record, async () => {
          checkPersonId(personId, "exportPersonalData");
          await vouchBefore(...readModelNames);
        });
        const streamed = await recorded(
          // Only a failure is recorded here: what resolves is recorded as it starts and ends.
          async (outcome, error) => {
            if (outcome === "failed") await record(outcome, error);
          },
          async () => {
            await pendingDeclarations.refresh();
            return streamPersonalData({
              storage,
              readModels,
              aggregates,
              processes: processDefinitions,
              sealing,
              clock,
              batchSize: config.runtime.dispatcher.batchSize,
              categories: personalCategories,
              recipients,
              transfers,
              personId,
              includeWithheld,
              // The header and each page, vouched for before they are handed out.
              onPage: () => vouchAfter(...readModelNames),
            });
          },
        );
        others = streamed.others;
        return recordedExport({
          streamed,
          record,
          onError: (error) => {
            if (error instanceof TenantForgottenError) onTenantForgotten();
          },
        });
      };
      const exportTenantAs = async (name: string): Promise<AsyncIterable<TenantExportPart>> => {
        const exportId = ids.next();
        const record = (
          outcome: ExportOutcome,
          error: unknown,
          counts: TenantExportCounts = NO_TENANT_EXPORT_RECORDS,
          persons: readonly string[] = [],
        ) =>
          recordAccess({
            operation: "exportTenant",
            detail: { exportId, ...counts },
            actor,
            persons,
            personCount: counts.persons,
            outcome,
            error,
          });
        // Another tenant, one not frozen, or a read model not served, refuses the export before it
        // reads.
        const frozenAt = await checked(record, async () => {
          named("exportTenant", name);
          const since = await whollyFrozen(fencedStores);
          if (since === null) {
            throw runtimeText(
              new ValidationError(
                `Tenant ${tenantId} is not frozen in every store: freeze it with freezeTenant, then export it`,
                [{ path: ["tenant"], message: "Expected a frozen tenant" }],
              ),
            );
          }
          await vouchBefore(...readModelNames);
          return since;
        });
        // Read once, as the freeze holds them: one a start adds meanwhile comes after the cut.
        await pendingDeclarations.refresh();
        const pinned = await unwritten(adapted.inboxLedger, pendingDeclarations.held());
        const streamed = await recorded(
          // Only a failure is recorded here: what resolves is recorded as it starts and ends.
          async (outcome, error) => {
            if (outcome === "failed") await record(outcome, error);
          },
          () =>
            streamTenantExport({
              storage: {
                ...storage,
                recipients: pendingRecipientsStore(adapted.recipients, async () => pinned),
              },
              readModels,
              aggregates,
              processes: processDefinitions,
              sealing,
              clock,
              batchSize: config.runtime.dispatcher.batchSize,
              categories: personalCategories,
              recipients,
              ports: returningPorts,
              transfers,
              tenant: tenantId,
              exportId,
              ledger: forgetLedger?.store ?? null,
              frozenAt,
              // The header and each page, vouched for before they are handed out, and read under
              // the same freeze: one lifted meanwhile may have let writes into what was read.
              onPage: async () => {
                await vouchAfter(...readModelNames);
                const fence = await adapted.fence.read();
                if (fence.state === "forgotten") throw fenceError(fence);
                if (fence.state !== "frozen" || fence.since !== frozenAt) {
                  throw runtimeText(
                    new ValidationError(
                      `Tenant ${tenantId}'s freeze of ${frozenAt} was lifted while it was exported: freeze it again, then export it`,
                      [
                        {
                          path: ["tenant"],
                          message: "Expected the tenant frozen until the export ends",
                        },
                      ],
                    ),
                  );
                }
              },
            }),
        );
        return recordedTenantExport({
          streamed,
          record,
          onError: (error) => {
            if (error instanceof TenantForgottenError) onTenantForgotten();
          },
        });
      };
      const failures = createSubscriberFailures({
        tracer: appTracer,
        store: written.subscriberFailures,
        keys: storage.personalKeys,
        persons: storage.persons,
        actor,
        recordAccess,
        errorText,
        vouch: () => vouchAfter(),
      });
      const letters = createDeadLetters({
        tracer: appTracer,
        storage,
        retries,
        processes,
        clock,
        logger,
        errorText,
        actor,
        recordAccess,
        vouch: () => vouchAfter(),
      });
      return {
        commands: createCommandsFacade({
          aggregates,
          dispatch: (command) => pipeline.dispatch({ ...command, actor }),
        }) as CommandsFacade<R>,
        queries: queryRunner.facade(actor) as QueriesFacade<R>,
        getLag,
        status: () =>
          tracedOperation({
            tracer: appTracer,
            errorText,
            operation: "status",
            actor,
            run: status,
          }),
        subscriberFailures: failures,
        events,
        deadLetters: letters,
        rebuildReadModel: (name) =>
          tracedOperation({
            tracer: appTracer,
            errorText,
            operation: "rebuildReadModel",
            actor,
            run: () => rebuild(name, actor === undefined ? {} : { actor }),
          }),
        forget: (personId, options) =>
          tracedOperation({
            tracer: appTracer,
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
        recipientsOf: (personId) =>
          tracedOperation({
            tracer: appTracer,
            errorText,
            operation: "recipientsOf",
            actor,
            run: async () => {
              let listed: readonly PersonRecipient[] | undefined;
              const record = (outcome: ReadOutcome, error: unknown) =>
                recordAccess({
                  operation: "recipientsOf",
                  detail: listed === undefined ? null : { recipients: listed.length },
                  actor,
                  persons: isPersonId(personId) ? [personId] : [],
                  outcome,
                  error,
                });
              await checked(record, () => checkPersonId(personId, "recipientsOf"));
              return recorded(record, async () => {
                // Another instance's start may have declared some since this one read them.
                await pendingDeclarations.refresh();
                listed = await listRecipientsOf({
                  storage,
                  recipients,
                  categories: personalCategories,
                  personId,
                });
                return listed;
              });
            },
          }),
        exportPersonalData: (personId, options) =>
          tracedOperation({
            tracer: appTracer,
            errorText,
            operation: "exportPersonalData",
            actor,
            run: async () => {
              // Nothing is handed out before the whole is read: an export the person's changes
              // overtook reads them again, as a command does.
              for (let attempt = 0; ; attempt += 1) {
                try {
                  return await collectPersonalDataExport(await streamAs(personId, options));
                } catch (error) {
                  const again =
                    error instanceof PersonalDataChangedError && attempt < concurrencyRetries;
                  if (!again) throw error;
                }
              }
            },
          }),
        streamPersonalData: (personId, options) =>
          tracedOperation({
            tracer: appTracer,
            errorText,
            operation: "streamPersonalData",
            actor,
            run: () => streamAs(personId, options),
          }),
        restrict: (personId, options) =>
          tracedOperation({
            tracer: appTracer,
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
            tracer: appTracer,
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
            tracer: appTracer,
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
        forgetTenant: (name, options) =>
          tracedOperation({
            tracer: appTracer,
            errorText,
            operation: "forgetTenant",
            actor,
            run: () => forgetThisTenant(name, options, actor),
          }),
        exportTenant: (name) =>
          tracedOperation({
            tracer: appTracer,
            errorText,
            operation: "exportTenant",
            actor,
            run: () => exportTenantAs(name),
          }),
        freezeTenant: (name) =>
          tracedOperation({
            tracer: appTracer,
            errorText,
            operation: "freezeTenant",
            actor,
            run: () => freezeThisTenant(name),
          }),
        unfreezeTenant: (name) =>
          tracedOperation({
            tracer: appTracer,
            errorText,
            operation: "unfreezeTenant",
            actor,
            run: () => unfreezeThisTenant(name),
          }),
        rotateTenantKey: (options) =>
          tracedOperation({
            tracer: appTracer,
            errorText,
            operation: "rotateTenantKey",
            actor,
            run: () => rotateTenantKey(options),
          }),
        retireTenantKeys: () =>
          tracedOperation({
            tracer: appTracer,
            errorText,
            operation: "retireTenantKeys",
            actor,
            run: () => retireTenantKeys(),
          }),
        as: (next) => {
          checkActor(next);
          return clientAs(next);
        },
      };
    };

    const clientOf = (
      actor: string | undefined,
    ): BoundaClient<R> & { readonly deadLetters: DeadLetters } => {
      const live = clientAs(actor);
      const gate = guarded(live);
      // Each call goes to what serves it then: the live app's letters, or, once the tenant is
      // forgotten, those of the notices to its recipients.
      const letters = (): DeadLetters => forgottenRunner?.deadLetters(actor) ?? gate.deadLetters;
      const client: BoundaClient<R> & { readonly deadLetters: DeadLetters } = {
        commands: gate.commands,
        queries: gate.queries,
        getLag: () => forgottenRunner?.getLag() ?? gate.getLag(),
        status: () => forgottenRunner?.status() ?? gate.status(),
        subscriberFailures: gate.subscriberFailures,
        events: gate.events,
        deadLetters: {
          list: (args, options) => letters().list(args, options),
          count: (args) => letters().count(args),
          get: (id, options) => letters().get(id, options),
          retry: (id) => letters().retry(id),
          discard: (id) => letters().discard(id),
        },
        rebuildReadModel: (name) => gate.rebuildReadModel(name),
        forget: (personId, options) => gate.forget(personId, options),
        exportPersonalData: (personId, options) => gate.exportPersonalData(personId, options),
        streamPersonalData: (personId, options) => gate.streamPersonalData(personId, options),
        recipientsOf: (personId) => gate.recipientsOf(personId),
        restrict: (personId, options) => gate.restrict(personId, options),
        unrestrict: (personId, options) => gate.unrestrict(personId, options),
        redact: (personId, options) => gate.redact(personId, options),
        forgetTenant: (name, options) => live.forgetTenant(name, options),
        exportTenant: (name) => gate.exportTenant(name),
        freezeTenant: (name) => gate.freezeTenant(name),
        unfreezeTenant: (name) => gate.unfreezeTenant(name),
        rotateTenantKey: (options) => gate.rotateTenantKey(options),
        retireTenantKeys: () => gate.retireTenantKeys(),
        as: (next) => {
          live.as(next);
          return clientOf(next);
        },
      };
      return recordedRejections({ client, record: recordRejection, tenant: tenantId, actor });
    };
    const operations = guarded({
      rebuildReadModel: rebuild,
      forgetAgain: async (
        entries: readonly ForgetAgainEntry[],
        { actor }: ForgetAgainOptions = {},
      ): Promise<readonly string[]> => {
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
      restored: async ({ again = false } = {}): Promise<RestoreDeclaration> => {
        const declared = await restores.declare({ again });
        // Counted nothing: the restore it would declare was handled already.
        if (declared.counted) await restartFound(declared);
        return { counted: declared.counted };
      },
    });
    const lifecycle: Omit<BoundaApp<R>, Exclude<keyof BoundaClient<R>, "rebuildReadModel">> = {
      config,
      role,
      tenant: tenantId,
      start: () => {
        if (stopping !== undefined) return;
        started = true;
        if (entering !== null) {
          entering.then((runner) => runner.start()).catch(() => undefined);
          return;
        }
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
            // Stopped at once, before anything awaited: their timers go with the call.
            const background = Promise.all([dispatcher.stop(), worker.stop()]);
            const runner = await entering?.catch(() => null);
            await Promise.all([background, runner?.stop()]);
            await copies?.retry();
            await restores.flush();
            await readModelDatabases.flush();
            try {
              await readModels.close();
            } finally {
              try {
                await storage.close();
              } finally {
                await hierarchy?.close();
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
        if (entering !== null) {
          return { idle: await (await entering).runUntilIdle(maxPasses), rejections: [] };
        }
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
      // Nothing is due while the tenant is frozen: lifting the freeze is what wakes a host again.
      nextDueAt: async () => {
        if (entering !== null) return (await entering).nextDueAt();
        return fences.frozen() ? null : nextDueAt();
      },
      catchUpReadModels: async ({ through } = {}) => {
        if (entering !== null) return;
        if (through === undefined) return dispatcher.catchUp("projection");
        if (through.scheduled) return;
        await dispatcher.catchUpThrough(through);
      },
      rebuildReadModel: (name, options) => operations.rebuildReadModel(name, options),
      forgetAgain: (entries, options) => operations.forgetAgain(entries, options),
      restored: (options) => operations.restored(options),
      pendingRebuilds: async () => {
        if (entering !== null) return [];
        const paused = await Promise.all(
          Object.values(readModels.byName).map(async ({ name, storage }) =>
            (await pendingRebuilds(storage.checkpointStore)).includes(name) ? [name] : [],
          ),
        );
        return paused.flat();
      },
    };
    // The app's own `rebuildReadModel` takes the place of the client's.
    return watched({ ...clientOf(undefined), ...lifecycle } as BoundaApp<R>);
  } catch (error) {
    for (const close of opened) await close().catch(() => undefined);
    await ports.dispose();
    throw error;
  }
};
