import type { DeadLetterErrorType } from "../../adapter/storage/dead-letter-store.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  type PersonalDataForgottenPayload,
} from "../../modules/bounda-events.ts";
import {
  type NotifiedRecipient,
  RECIPIENT_HANDLERS,
  type RecipientHandlerName,
} from "../../modules/recipient.ts";
import type { Subscriber } from "../dispatch/dispatcher.ts";
import type { AppStorage } from "../events/app-event-store.ts";
import { type RecordAccess, recorded } from "../personal-data/access.ts";
import { sealError } from "../personal-data/errors.ts";
import { actedBy, causedBy } from "../shared/causation.ts";
import { deriveDeadLetterId, deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import type { ReactionOutcome } from "../shared/in-order.ts";
import type { PendingRetries } from "../shared/pending-retries.ts";
import { runAttempt } from "../shared/reaction-attempt.ts";
import { withTimeout } from "../shared/timeout.ts";
import { ATTRIBUTES, actorAttribute, deadLettered, traced } from "../telemetry.ts";
import type { UnitStores } from "../unit-of-work/unit-of-work.ts";
import { RECIPIENT_EVENT_TYPES } from "./addressing.ts";
import type { RecipientRuntime, RecipientsRuntime } from "./build.ts";

export const RECIPIENTS_SUBSCRIBER: "recipients" = "recipients";

const HANDLER_OF: Readonly<Record<string, RecipientHandlerName>> = Object.fromEntries(
  Object.entries(RECIPIENT_HANDLERS).map(([handler, type]) => [type, handler]),
) as Readonly<Record<string, RecipientHandlerName>>;

/**
 * The port an event names a recipient by, as the app declares it now: a former key leads to the
 * port that took it over.
 */
const portOf = (recipients: RecipientsRuntime, port: string): string =>
  recipients.byPort[port]?.port ?? port;

export interface NoticesOfFunction {
  (event: StoredEvent): readonly NotifiedRecipient[];
}

/**
 * The recipients an event of the runtime's names to tell, none for any other event.
 */
export const noticesOf: NoticesOfFunction = (event) =>
  event.aggregateType === BOUNDA_AGGREGATE && RECIPIENT_EVENT_TYPES.has(event.type)
    ? ((event.payload as { readonly recipients?: readonly NotifiedRecipient[] }).recipients ?? [])
    : [];

export interface RunNoticeArgs {
  /**
   * The port as the event names it.
   */
  readonly port: string;
  readonly event: StoredEvent;
  readonly attempt: number;
  readonly retryId?: string | undefined;
  readonly actor?: string | undefined;
  readonly within: UnitStores;
}

/**
 * Tells one recipient of one event, through the handler its port module exports: the live
 * subscriber and a dead letter's retry both run it.
 */
export interface RecipientNotices {
  run(args: RunNoticeArgs): Promise<void>;
}

export interface CreateRecipientNoticesArgs {
  readonly recipients: RecipientsRuntime;
  readonly storage: Pick<AppStorage, "eventStore">;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly recordAccess: RecordAccess;
}

export interface CreateRecipientNoticesFunction {
  (args: CreateRecipientNoticesArgs): RecipientNotices;
}

// Whether a forgetting of the person as a whole, after `event`, told the recipient already: a
// restriction, a lift or a redaction told after it would only bring back what it had to erase.
const superseded = async (
  storage: Pick<AppStorage, "eventStore">,
  recipients: RecipientsRuntime,
  recipient: RecipientRuntime,
  event: StoredEvent,
): Promise<boolean> => {
  if (event.type === PERSONAL_DATA_FORGOTTEN_EVENT) return false;
  const { events } = await storage.eventStore.load({
    aggregateType: BOUNDA_AGGREGATE,
    aggregateId: event.aggregateId,
    fromVersion: event.version + 1,
  });
  return events.some(
    (later) =>
      later.type === PERSONAL_DATA_FORGOTTEN_EVENT &&
      (later.payload as PersonalDataForgottenPayload).whole &&
      noticesOf(later).some(({ port }) => portOf(recipients, port) === recipient.port),
  );
};

export const createRecipientNotices: CreateRecipientNoticesFunction = ({
  recipients,
  storage,
  config,
  clock,
  recordAccess,
}) => ({
  // A notice writes nothing: the unit it runs on commits the claim, or the letter, alone.
  run: async ({ port, event, attempt, retryId, actor }) => {
    const told = noticesOf(event).find((notice) => notice.port === port);
    const recipient = recipients.byPort[port];
    const handler = HANDLER_OF[event.type];
    if (told === undefined || handler === undefined) return;
    if (recipient === undefined) {
      throw new ConfigurationError(
        `Port ${port} is not declared any more, so its recipient cannot be told of ${event.type} ${event.id}: declare it again, or name it in recipient.formerly of the port that took over, and retry this letter, or tell the recipient by hand and discard it`,
      );
    }
    const context = { ...causedBy(event), ...actedBy(actor) };
    const record = (outcome: "ok" | "failed", skipped: boolean) =>
      recordAccess({
        operation: "recipientNotice",
        detail: {
          recipient: recipient.port,
          event: event.type,
          eventId: event.id,
          categories: [...told.categories, ...told.retained],
          superseded: skipped,
        },
        actor: context.actor,
        persons: [event.aggregateId],
        outcome,
      });
    if (await superseded(storage, recipients, recipient, event)) {
      await record("ok", true);
      return;
    }
    const idempotencyKey = deriveIdempotencyKey({
      kind: "recipient",
      handler: recipient.port,
      subject: event.id,
      retryId,
    });
    const { policies } = config.forAggregate(recipient.owner);
    await recorded(
      (outcome) => record(outcome, false),
      () =>
        traced({
          errorText: config.runtime.telemetry.errorText,
          name: `bounda.recipient ${recipient.port}`,
          attributes: {
            [ATTRIBUTES.recipient]: recipient.port,
            [ATTRIBUTES.eventId]: event.id,
            [ATTRIBUTES.eventType]: event.type,
            [ATTRIBUTES.correlationId]: event.metadata.correlationId,
            [ATTRIBUTES.attempt]: attempt,
            ...actorAttribute(context.actor),
          },
          run: () =>
            withTimeout({
              run: async (signal) => {
                await (recipient.handlers[handler] as (args: unknown) => unknown)({
                  event,
                  categories: told.categories,
                  ...(event.type === PERSONAL_DATA_FORGOTTEN_EVENT
                    ? { retained: told.retained }
                    : {}),
                  presumed: told.presumed,
                  idempotencyKey,
                  signal,
                  [recipient.name]: recipient.implementation(),
                });
              },
              timeoutMs: policies.timeoutMs,
              subject: `recipient ${recipient.port}`,
              clock,
            }),
        }),
    );
  },
});

export interface CreateRecipientSubscriberArgs {
  readonly recipients: RecipientsRuntime;
  readonly notices: RecipientNotices;
  readonly storage: AppStorage;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly pendingRetries: PendingRetries;
  readonly logger: Logger;
}

export interface CreateRecipientSubscriberFunction {
  (args: CreateRecipientSubscriberArgs): Subscriber;
}

/**
 * Tells every recipient an event of the runtime's names, each through its own claim, retries and
 * dead letter, as a policy reacts: once at least, in the order of the person's events. A
 * recipient that holds an event, for a pending retry or a claim another instance has, is handed
 * none of its later events of the batch; the others carry on. A port the app no longer declares
 * gives up at once, its letter saying so.
 */
export const createRecipientSubscriber: CreateRecipientSubscriberFunction = ({
  recipients,
  notices,
  storage,
  config,
  clock,
  pendingRetries,
  logger,
}) => {
  const letterIdOf = (port: string, event: StoredEvent): string =>
    deriveDeadLetterId({ kind: "recipient", handler: port, subject: event.id });

  const deliver = (port: string, event: StoredEvent): Promise<ReactionOutcome> => {
    const owner = recipients.byPort[port]?.owner ?? port.split(".")[0] ?? port;
    const { policies } = config.forAggregate(owner);
    return runAttempt({
      storage,
      key: { handler: `recipient:${port}`, eventId: event.id },
      retry: policies.retry,
      leaseMs: policies.timeoutMs * 2,
      concurrencyRetries: config.runtime.commands.concurrencyRetries,
      clock,
      pendingRetries,
      run: (unit, attempt) => notices.run({ port, event, attempt, within: unit }),
      giveUp: async (unit, error, attempts, errorType: DeadLetterErrorType) => {
        const now = clock.now().toISOString();
        await unit.deadLetterStore.add({
          id: letterIdOf(port, event),
          kind: "recipient",
          handler: port,
          eventId: event.id,
          eventType: event.type,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          person: event.aggregateId,
          errorType,
          ...(await sealError({
            error,
            person: event.aggregateId,
            keys: storage.personalKeys,
          })),
          attempts,
          firstFailedAt: now,
          lastFailedAt: now,
        });
      },
      gaveUp: (attempts, errorType, error) => {
        deadLettered({ kind: "recipient", handler: port, errorType });
        logger.warn("recipient notice dead-lettered", {
          recipient: port,
          eventId: event.id,
          letterId: letterIdOf(port, event),
          errorType,
          attempts,
          error,
        });
      },
      willRetry: (attempts, error) => {
        logger.warn("recipient notice failed; will retry", {
          recipient: port,
          eventId: event.id,
          attempts,
          error,
        });
      },
    });
  };

  return {
    name: RECIPIENTS_SUBSCRIBER,
    kind: "policy",
    process: async (events) => {
      const held = new Set<string>();
      let done = events.length;
      for (const [index, event] of events.entries()) {
        for (const { port } of noticesOf(event)) {
          const key = portOf(recipients, port);
          if (held.has(key)) continue;
          if ((await deliver(port, event)) === "hold") {
            held.add(key);
            done = Math.min(done, index);
          }
        }
      }
      return done;
    },
  };
};
