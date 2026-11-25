import type {
  AppStatus,
  RecipientStatus,
  RestoreDeclaration,
  SchemaStatus,
  SubscriberFailure,
  SubscriberFailureStatus,
  UnreadableSchemaStatus,
} from "@bounda-dev/core";
import { isUnreadable } from "@bounda-dev/core";
import { DEFAULT_PERSONAL_CATEGORY } from "@bounda-dev/core/adapter";

export interface FormatStatusArgs {
  readonly status: AppStatus;
  /**
   * Each subscriber's last failure with its text, by subscriber, when `--error-text` asked for it.
   */
  readonly opened?: ReadonlyMap<string, SubscriberFailure>;
}

export interface FormatStatusFunction {
  (args: FormatStatusArgs): string;
}

export interface FormatSchemaFunction {
  (schema: readonly (SchemaStatus | UnreadableSchemaStatus)[]): string;
}

const UNREADABLE = "its store could not be read, see the logs";

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const days = (ms: number): string =>
  ms % 86_400_000 === 0 ? `${ms / 86_400_000}d` : `${Math.round(ms / 1_000)}s`;

const identity = (errorName: string, errorCode: string | undefined): string =>
  `${errorName}${errorCode === undefined ? "" : ` (${errorCode})`}`;

/**
 * The version of every scope of Bounda's tables, by database, as `bounda status` and
 * `bounda migrate` print it.
 */
export const formatSchema: FormatSchemaFunction = (schema) =>
  schema.length === 0
    ? "  no tables to version"
    : schema
        .map((each) =>
          isUnreadable(each)
            ? `  ${each.database}  ${UNREADABLE}`
            : `  ${each.database}  ${each.scope}  ${each.version} of ${each.latest}${each.version < each.latest ? "  (migrations pending: bounda migrate)" : ""}`,
        )
        .join("\n");

// A subscriber the app no longer runs got past nothing: its failure is resolved or it is not.
const stateOf = ({ current, resolvedAt }: SubscriberFailureStatus, gone: boolean): string => {
  if (current === true) return "failing";
  if (current === null) return "failed, not resolved";
  if (resolvedAt === null)
    return gone ? "last failed, not resolved" : "last failed, resolved since";
  return `last failed, resolved ${resolvedAt}`;
};

const failureOf = (
  failure: SubscriberFailureStatus | undefined,
  opened: FormatStatusArgs["opened"],
  gone = false,
): string[] => {
  if (failure === undefined) return [];
  const text = opened?.get(failure.subscriber)?.errorMessage;
  return [
    `    ${stateOf(failure, gone)}: ${identity(failure.errorName, failure.errorCode)} on ${failure.eventType} at ${failure.position}, ${plural(failure.attempts, "attempt")} since ${failure.firstFailedAt}`,
    ...(text === undefined
      ? []
      : [`    ${text === null ? "its text went with the person it was sealed under" : text}`]),
  ];
};

// Each subscriber's lag and last failure, then the failures of subscribers the app no longer runs,
// which the failure retention removes; without the lag, each failure under its subscriber.
const subscribersOf = ({ status, opened }: FormatStatusArgs): string[] => {
  const failures = isUnreadable(status.subscriberFailures) ? [] : status.subscriberFailures;
  const unreadFailures = isUnreadable(status.subscriberFailures)
    ? [`  last failures: ${UNREADABLE}`]
    : [];
  if (isUnreadable(status.lag)) {
    return [
      `subscribers: where they stand, ${UNREADABLE}`,
      ...failures.flatMap((failure) => [`  ${failure.subscriber}`, ...failureOf(failure, opened)]),
      ...unreadFailures,
    ];
  }
  const running = new Set(status.lag.subscribers.map(({ subscriber }) => subscriber));
  return [
    `subscribers (head at ${status.lag.lastPosition})`,
    ...status.lag.subscribers.flatMap((each) => [
      isUnreadable(each)
        ? `  ${each.subscriber}  its position, ${UNREADABLE}`
        : `  ${each.subscriber}  at ${each.position}, ${each.lag} behind`,
      ...failureOf(
        failures.find((failure) => failure.subscriber === each.subscriber),
        opened,
      ),
    ]),
    ...failures
      .filter(({ subscriber }) => !running.has(subscriber))
      .flatMap((failure) => [
        `  ${failure.subscriber}  no longer run`,
        ...failureOf(failure, opened, true),
      ]),
    ...unreadFailures,
  ];
};

const backfillOf = ({ personalDataBackfill: backfill }: AppStatus): string =>
  backfill === null
    ? "no personal data marked"
    : isUnreadable(backfill)
      ? UNREADABLE
      : `sealed through position ${backfill.position}, ${backfill.caughtUp ? "caught up" : "not caught up yet"}`;

const ledgerOf = ({ forgetLedger: ledger }: AppStatus): string => {
  if (ledger === null) return "not configured";
  if (isUnreadable(ledger)) return UNREADABLE;
  return [
    ledger.reconciled ? "reconciled" : "not reconciled since this instance started",
    `applied through ${ledger.appliedThrough ?? "nothing yet"}`,
    `last run ${ledger.lastRunAt ?? "never"}`,
    ...(ledger.held === null
      ? []
      : [`held until ${ledger.held.until} after ${plural(ledger.held.attempts, "failure")}`]),
  ].join(", ");
};

const tenantOf = ({ tenant }: AppStatus): string => {
  if (tenant === null) return "no keys: no personal data marked";
  if (isUnreadable(tenant)) return UNREADABLE;
  if (tenant.forgottenAt !== null) return `${tenant.tenant}, forgotten at ${tenant.forgottenAt}`;
  const { master } = tenant;
  const wrapped =
    master.pending === 0
      ? `wrapped under master key ${master.kid}`
      : `${plural(master.pending, "version")} left to rewrap under master key ${master.kid}`;
  return `${tenant.tenant}, key ${tenant.kid}${tenant.previous.length === 0 ? "" : ` (older ${tenant.previous.join(", ")})`}, ${wrapped}`;
};

// Printed only once the tenant is forgotten: when its database may be deleted.
const forgottenTenantOf = ({ forgottenTenant: forgotten }: AppStatus): string[] => {
  if (forgotten === null) return [];
  if (isUnreadable(forgotten)) return [`forgotten tenant: ${UNREADABLE}`];
  const { recipientsTold, forgetLedgerCleared, fileKeysDestroyed } = forgotten;
  const ledger =
    forgetLedgerCleared === null
      ? "no forget ledger"
      : forgetLedgerCleared
        ? "forget ledger cleared"
        : "forget ledger not cleared yet";
  const deletable = recipientsTold && forgetLedgerCleared !== false && fileKeysDestroyed;
  return [
    `forgotten tenant: ${recipientsTold ? "recipients told" : "recipients not all told yet"}, ${ledger}, ${fileKeysDestroyed ? "no file key kept" : "file keys still kept"}; ${deletable ? "the database may be deleted" : "keep the database"}`,
  ];
};

// Printed only while the tenant is frozen: whether `bounda export-tenant` hands it back as one cut.
const frozenTenantOf = ({ frozenTenant: frozen }: AppStatus): string[] => {
  if (frozen === null) return [];
  if (isUnreadable(frozen)) return [`frozen tenant: ${UNREADABLE}`];
  return [
    frozen.whole
      ? `frozen tenant: since ${frozen.frozenAt}, every store; no write lands until bounda unfreeze-tenant`
      : `frozen tenant: since ${frozen.frozenAt}, but not every store yet: run bounda freeze-tenant again`,
  ];
};

const FILE_STATES: Readonly<Record<AppStatus["files"][number]["state"], string>> = {
  current: "encrypted under the tenant's key in force",
  earlier: "still under an earlier key of the tenant's: bounda rekey",
  clear: "still in the clear: bounda rekey",
};

export interface FormatFilesFunction {
  (files: AppStatus["files"]): readonly string[];
}

// Every file the app opened under the tenant's keys, and where its encryption stands.
export const formatFiles: FormatFilesFunction = (files) =>
  files.length === 0
    ? []
    : [
        "database files",
        ...files.map(
          ({ database, file, state }) => `  ${database}  ${file}  ${FILE_STATES[state]}`,
        ),
      ];

const rotationOf = ({ keyRotation: rotation }: AppStatus): string => {
  if (rotation === null) return "not configured";
  if (isUnreadable(rotation)) return UNREADABLE;
  const left =
    rotation.pending === 0
      ? `every key wrapped${rotation.completeAt === null ? "" : ` (checked ${rotation.completeAt})`}`
      : `${plural(rotation.pending, "key")} left to rewrap`;
  return `under ${rotation.kid}${rotation.previous.length === 0 ? "" : ` (previous ${rotation.previous.join(", ")})`}, ${left}`;
};

// Only once the tenant's data was resealed, or while it is.
const resealOf = ({ keyRotation: rotation }: AppStatus): string[] => {
  const reseal = rotation === null || isUnreadable(rotation) ? null : rotation.reseal;
  if (reseal === null) return [];
  if (reseal.step === "complete") return [`reseal: complete (${reseal.completedAt})`];
  const kept = reseal.superseded === 0 ? "" : `, ${plural(reseal.superseded, "old key")} kept`;
  return [`reseal: ${reseal.step} since ${reseal.startedAt}${kept}`];
};

// One line per retention set: the app's forgets persons as a whole, a category's its keys.
const retentionOf = ({ retention }: AppStatus): string[] => {
  if (retention === null) return ["retention: no personal data marked"];
  if (isUnreadable(retention)) return [`retention: ${UNREADABLE}`];
  const { categories, keptBeyond } = retention;
  if (categories.length === 0 && keptBeyond === 0) return ["retention: not configured"];
  return [
    "retention",
    ...categories.map(
      ({ category, retention: kept, due, nextDueAt }) =>
        `  ${category}  ${kept}, ${plural(due, category === DEFAULT_PERSONAL_CATEGORY ? "person" : "key")} past it, next due ${nextDueAt ?? "never"}`,
    ),
    ...(keptBeyond === 0
      ? []
      : [`  ${plural(keptBeyond, "key")} kept past a forgetting that no erasure exemption keeps`]),
  ];
};

const purgeOf = ({ deadLetterRetention: purge }: AppStatus): string => {
  if (purge === null)
    return "none kept but the notices of the forgetting, the tenant was forgotten";
  if (isUnreadable(purge)) return `${days(purge.retentionMs)}, ${UNREADABLE}`;
  const next = `${days(purge.retentionMs)}, next purge ${purge.nextDueAt ?? "when a letter is resolved"}`;
  return [
    next,
    ...(purge.held === 0
      ? []
      : [
          `${plural(purge.held, "letter")} past it kept while a person it holds data of is restricted`,
        ]),
    ...(purge.withoutHandler === 0
      ? []
      : [
          `${plural(purge.withoutHandler, "failed letter")} of a handler the app no longer runs, kept until discarded: bounda dead-letters list --status failed`,
        ]),
  ].join("; ");
};

const failurePurgeOf = ({ subscriberFailureRetention: purge }: AppStatus): string => {
  if (purge === null) return "none kept, the tenant was forgotten";
  if (isUnreadable(purge)) return `${days(purge.retentionMs)}, ${UNREADABLE}`;
  const next = `${days(purge.retentionMs)}, next purge ${purge.nextDueAt ?? "when a failure is resolved"}`;
  return purge.held === 0
    ? next
    : `${next}; ${plural(purge.held, "failure")} past it kept while a person it is sealed under is restricted`;
};

export interface FormatRecipientsFunction {
  (recipients: readonly RecipientStatus[]): readonly string[];
}

/**
 * Every recipient, one line each, and what of it needs an operator, as `bounda status` and
 * `bounda recipients` print them.
 */
export const formatRecipients: FormatRecipientsFunction = (recipients) =>
  recipients.length === 0
    ? ["recipients: none declared"]
    : [
        "recipients",
        ...recipients.flatMap(({ port, declared, persons, catchingUp, failedNotices }) => [
          declared === null
            ? `  ${port}  no longer declared, ${plural(persons, "person")} disclosed to it`
            : `  ${port}  ${declared.name}, ${declared.kind}, ${declared.country}${declared.safeguard === null ? "" : ` on ${declared.safeguard}`}: ${declared.categories.join(", ")}; ${plural(persons, "person")} disclosed to it`,
          ...(catchingUp ? ["    being told what was recorded before it was declared"] : []),
          ...(failedNotices === 0
            ? []
            : [
                `    ${plural(failedNotices, "notice")} failed: bounda dead-letters list --kind recipient --handler ${port}`,
              ]),
        ]),
      ];

export interface FormatRestoredFunction {
  (found: AppStatus["restoresFound"], declared: RestoreDeclaration): string;
}

// What `bounda restored` prints once the restore is recorded, whether or not the count could be
// read back, or once it counted nothing.
export const formatRestored: FormatRestoredFunction = (found, { counted }) =>
  counted
    ? `restore recorded: ${isUnreadable(found) ? `how many were found so far, ${UNREADABLE}` : `${found} found so far`}; the background jobs start over from the copy, without the holds it brought back`
    : "nothing counted: the database stands exactly where handling the last restore left it, as when this already ran or a start found that restore; if it was restored from a copy taken right then, run bounda restored --again";

/**
 * Where the runtime's background work stands, as `bounda status` prints it.
 */
export const formatStatus: FormatStatusFunction = (args) => {
  const { status } = args;
  return [
    "tables",
    formatSchema(status.schema),
    `restores found while running: ${isUnreadable(status.restoresFound) ? UNREADABLE : status.restoresFound}`,
    ...subscribersOf(args),
    `personal data backfill: ${backfillOf(status)}`,
    `forget ledger: ${ledgerOf(status)}`,
    `tenant: ${tenantOf(status)}`,
    ...forgottenTenantOf(status),
    ...frozenTenantOf(status),
    ...formatFiles(status.files),
    `key rotation: ${rotationOf(status)}`,
    ...resealOf(status),
    ...retentionOf(status),
    `dead letter retention: ${purgeOf(status)}`,
    `subscriber failure retention: ${failurePurgeOf(status)}`,
    ...(isUnreadable(status.recipients)
      ? [`recipients: ${UNREADABLE}`]
      : formatRecipients(status.recipients)),
  ].join("\n");
};
