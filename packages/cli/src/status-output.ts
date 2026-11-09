import type { AppStatus, SchemaStatus, SubscriberFailure } from "@bounda-dev/core";

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
  (schema: readonly SchemaStatus[]): string;
}

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
        .map(
          ({ database, scope, version, latest }) =>
            `  ${database}  ${scope}  ${version} of ${latest}${version < latest ? "  (migrations pending: bounda migrate)" : ""}`,
        )
        .join("\n");

const subscribersOf = ({ status, opened }: FormatStatusArgs): string[] =>
  status.lag.subscribers.flatMap(({ subscriber, position, lag }) => {
    const failure = status.subscriberFailures.find((each) => each.subscriber === subscriber);
    const text = opened?.get(subscriber)?.errorMessage;
    return [
      `  ${subscriber}  at ${position}, ${lag} behind`,
      ...(failure === undefined
        ? []
        : [
            `    ${failure.current ? "failing" : `last failed, resolved ${failure.resolvedAt ?? "since"}`}: ${identity(failure.errorName, failure.errorCode)} on ${failure.eventType} at ${failure.position}, ${plural(failure.attempts, "attempt")} since ${failure.firstFailedAt}`,
            ...(text === undefined
              ? []
              : [
                  `    ${text === null ? "its text went with the person it was sealed under" : text}`,
                ]),
          ]),
    ];
  });

const backfillOf = ({ personalDataBackfill: backfill }: AppStatus): string =>
  backfill === null
    ? "no personal data marked"
    : `sealed through position ${backfill.position}, ${backfill.caughtUp ? "caught up" : "not caught up yet"}`;

const ledgerOf = ({ forgetLedger: ledger }: AppStatus): string => {
  if (ledger === null) return "not configured";
  return [
    ledger.reconciled ? "reconciled" : "not reconciled since this instance started",
    `applied through ${ledger.appliedThrough ?? "nothing yet"}`,
    `last run ${ledger.lastRunAt ?? "never"}`,
    ...(ledger.held === null
      ? []
      : [`held until ${ledger.held.until} after ${plural(ledger.held.attempts, "failure")}`]),
  ].join(", ");
};

const rotationOf = ({ keyRotation: rotation }: AppStatus): string => {
  if (rotation === null) return "not configured";
  const left =
    rotation.pending === 0
      ? `every key wrapped${rotation.completeAt === null ? "" : ` (checked ${rotation.completeAt})`}`
      : `${plural(rotation.pending, "key")} left to rewrap`;
  return `under ${rotation.kid}${rotation.previous.length === 0 ? "" : ` (previous ${rotation.previous.join(", ")})`}, ${left}`;
};

const retentionOf = ({ retention }: AppStatus): string =>
  retention === null
    ? "not configured"
    : `${days(retention.retentionMs)}, ${plural(retention.due, "person")} past it, next due ${retention.nextDueAt ?? "never"}`;

const purgeOf = ({ deadLetterRetention: purge }: AppStatus): string =>
  purge === null
    ? "not configured"
    : `${days(purge.retentionMs)}, next purge ${purge.nextDueAt ?? "when a letter is resolved"}`;

/**
 * Where the runtime's background work stands, as `bounda status` prints it.
 */
export const formatStatus: FormatStatusFunction = (args) => {
  const { status } = args;
  return [
    "tables",
    formatSchema(status.schema),
    `restores found while running: ${status.restoresFound}`,
    `subscribers (head at ${status.lag.lastPosition})`,
    ...subscribersOf(args),
    `personal data backfill: ${backfillOf(status)}`,
    `forget ledger: ${ledgerOf(status)}`,
    `key rotation: ${rotationOf(status)}`,
    `retention: ${retentionOf(status)}`,
    `dead letter retention: ${purgeOf(status)}`,
  ].join("\n");
};
