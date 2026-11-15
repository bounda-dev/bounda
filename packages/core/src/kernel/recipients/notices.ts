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
  TENANT_FORGOTTEN_EVENT,
} from "../../modules/bounda-events.ts";
import type { PersonalCategoryName } from "../../modules/personal-data.ts";
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
import { RECIPIENT_EVENT_TYPES, type RecipientEvent, touchedBy, within } from "./addressing.ts";
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
 * The recipients an event of the runtime's names to tell, a tenant's forgetting included, none for
 * any other event.
 */
export const noticesOf: NoticesOfFunction = (event) =>
  event.aggregateType === BOUNDA_AGGREGATE &&
  (RECIPIENT_EVENT_TYPES.has(event.type) || event.type === TENANT_FORGOTTEN_EVENT)
    ? ((event.payload as { readonly recipients?: readonly NotifiedRecipient[] }).recipients ?? [])
    : [];

export interface PresumedNoticeFunction {
  (recipient: RecipientRuntime, event: StoredEvent): NotifiedRecipient | undefined;
}

/**
 * What a recipient declared after an event of the runtime's is told of it, presumed to hold every
 * category it declares; `undefined` when the event touches none of them.
 */
export const presumedNotice: PresumedNoticeFunction = (recipient, event) => {
  if (HANDLER_OF[event.type] === undefined) return undefined;
  const touched = touchedBy(event as unknown as RecipientEvent);
  const declared = new Set(recipient.categories);
  const categories = within(declared, touched.categories);
  const retained = within(declared, touched.retained);
  if (categories.length === 0 && retained.length === 0) return undefined;
  return {
    port: recipient.port,
    categories: categories as PersonalCategoryName[],
    retained: retained as PersonalCategoryName[],
    presumed: true,
  };
};

export interface RunNoticeArgs {
  /**
   * The port as the event names it.
   */
  readonly port: string;
  /**
   * What the recipient is told, for an event that does not name it: what a recipient declared
   * after the event is presumed to hold of what it touches. Read from the event when omitted, or
   * so presumed when the event does not name the port.
   */
  readonly told?: NotifiedRecipient | undefined;
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
  readonly storage: Pick<AppStorage, "eventStore" | "recipients">;
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
  if (event.type === PERSONAL_DATA_FORGOTTEN_EVENT || event.type === TENANT_FORGOTTEN_EVENT) {
    return false;
  }
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

// How many persons a page of `onTenantForgotten`'s `persons` reads at once.
const PERSONS_PAGE = 500;

// The persons the store recorded as disclosed to the port, page by page, in order.
const disclosedTo = (
  storage: Pick<AppStorage, "recipients">,
  port: string,
): (() => AsyncIterable<string>) =>
  async function* persons() {
    let after: string | null = null;
    for (;;) {
      const page = await storage.recipients.personsOf({ port, after, limit: PERSONS_PAGE });
      yield* page;
      if (page.length < PERSONS_PAGE) return;
      after = page.at(-1) ?? null;
    }
  };

export const createRecipientNotices: CreateRecipientNoticesFunction = ({
  recipients,
  storage,
  config,
  clock,
  recordAccess,
}) => ({
  // A notice writes nothing: the unit it runs on commits the claim, or the letter, alone.
  run: async ({ port, event, attempt, retryId, actor, told: given }) => {
    const recipient = recipients.byPort[port];
    const handler = HANDLER_OF[event.type];
    if (handler === undefined) return;
    const told =
      given ??
      noticesOf(event).find((notice) => notice.port === port) ??
      (recipient === undefined ? undefined : presumedNotice(recipient, event));
    if (told === undefined) return;
    if (recipient === undefined) {
      throw new ConfigurationError(
        `Port ${port} is not declared any more, so its recipient cannot be told of ${event.type} ${event.id}: declare it again, or name it in recipient.formerly of the port that took over, and retry this letter, or tell the recipient by hand and discard it`,
      );
    }
    const context = { ...causedBy(event), ...actedBy(actor) };
    const tenantWide = event.type === TENANT_FORGOTTEN_EVENT;
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
        persons: tenantWide ? [] : [event.aggregateId],
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
                  ...(tenantWide ? { persons: disclosedTo(storage, recipient.port) } : {}),
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

export interface RecipientDelivery {
  /**
   * Tells the port's recipient of the event, through its own claim, retries and dead letter, as a
   * policy reacts: `hold` while a retry waits or another instance holds the claim.
   */
  deliver(port: string, event: StoredEvent, told?: NotifiedRecipient): Promise<ReactionOutcome>;
}

export interface CreateRecipientDeliveryArgs {
  readonly recipients: RecipientsRuntime;
  readonly notices: RecipientNotices;
  readonly storage: AppStorage;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly pendingRetries: PendingRetries;
  readonly logger: Logger;
}

// A tenant's forgetting names no person: its letter names none, and its text names none either.
const personOf = (event: StoredEvent): string | null =>
  event.type === TENANT_FORGOTTEN_EVENT ? null : event.aggregateId;

export interface CreateRecipientDeliveryFunction {
  (args: CreateRecipientDeliveryArgs): RecipientDelivery;
}

/**
 * A port the app no longer declares gives up at once, its letter saying so.
 */
export const createRecipientDelivery: CreateRecipientDeliveryFunction = ({
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
  return {
    deliver: (port, event, told) => {
      // A port no longer declared gives up at once, on the app's own settings.
      const { policies } = config.forAggregate(recipients.byPort[port]?.owner ?? "");
      return runAttempt({
        storage,
        key: { handler: `recipient:${port}`, eventId: event.id },
        retry: policies.retry,
        leaseMs: policies.timeoutMs * 2,
        concurrencyRetries: config.runtime.commands.concurrencyRetries,
        clock,
        pendingRetries,
        run: (unit, attempt) => notices.run({ port, event, attempt, told, within: unit }),
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
            person: personOf(event),
            errorType,
            ...(await sealError({ error, person: personOf(event), keys: storage.personalKeys })),
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
    },
  };
};

export interface CreateRecipientSubscriberArgs {
  readonly recipients: RecipientsRuntime;
  readonly delivery: RecipientDelivery;
  readonly storage: Pick<AppStorage, "recipients">;
}

export interface CreateRecipientSubscriberFunction {
  (args: CreateRecipientSubscriberArgs): Subscriber;
}

/**
 * Tells every recipient an event of the runtime's names, once at least, in the order of the
 * person's events. A recipient that holds an event, for a pending retry, a claim another instance
 * has, or the earlier events it is still being told of since it was declared, is handed none of its
 * later events of the batch; the others carry on.
 */
export const createRecipientSubscriber: CreateRecipientSubscriberFunction = ({
  recipients,
  delivery,
  storage,
}) => ({
  name: RECIPIENTS_SUBSCRIBER,
  kind: "policy",
  process: async (events) => {
    const held = new Set<string>();
    let done = events.length;
    let behind: ReadonlySet<string> | undefined;
    for (const [index, event] of events.entries()) {
      const notices = noticesOf(event);
      if (notices.length === 0) continue;
      behind ??= new Set(
        (await storage.recipients.declared())
          .filter(({ caughtUpThrough, presumedThrough }) => caughtUpThrough < presumedThrough)
          .map(({ port }) => port),
      );
      for (const { port } of notices) {
        const key = portOf(recipients, port);
        if (held.has(key)) continue;
        if (behind.has(key) || (await delivery.deliver(port, event)) === "hold") {
          held.add(key);
          done = Math.min(done, index);
        }
      }
    }
    return done;
  },
});

export interface CreateRecipientCatchUpArgs {
  readonly recipients: RecipientsRuntime;
  readonly delivery: RecipientDelivery;
  /**
   * The store as written, whose runtime events hold nothing sealed.
   */
  readonly storage: Pick<AppStorage, "recipients" | "eventStore">;
  readonly batchSize: number;
}

export interface RecipientCatchUp {
  /**
   * Tells each recipient declared after the store held events of what they recorded before, a
   * batch of events at a time, and resolves to how many notices it delivered.
   */
  sweep(): Promise<number>;
}

export interface CreateRecipientCatchUpFunction {
  (args: CreateRecipientCatchUpArgs): RecipientCatchUp;
}

/**
 * A recipient declared after data already existed is presumed to hold it, and so to hold what a
 * forgetting, a restriction or a redaction before it was declared touched: each such event is told
 * to it, presumed, in order, before any later one is; one it holds stops it for this pass.
 */
export const createRecipientCatchUp: CreateRecipientCatchUpFunction = ({
  recipients,
  delivery,
  storage,
  batchSize,
}) => ({
  sweep: async () => {
    let told = 0;
    for (const declared of await storage.recipients.declared()) {
      if (declared.caughtUpThrough >= declared.presumedThrough) continue;
      const recipient = recipients.byPort[declared.port];
      if (recipient === undefined || recipient.port !== declared.port) continue;
      const events = await storage.eventStore.readAll({
        afterPosition: declared.caughtUpThrough,
        limit: batchSize,
      });
      // Done through the position presumed when the stream ends before it; a full batch is done
      // through its last event.
      let through = declared.presumedThrough;
      for (const event of events) {
        if (event.position > declared.presumedThrough) {
          through = declared.presumedThrough;
          break;
        }
        const notice =
          event.aggregateType === BOUNDA_AGGREGATE ? presumedNotice(recipient, event) : undefined;
        if (notice !== undefined) {
          if ((await delivery.deliver(recipient.port, event, notice)) === "hold") {
            through = event.position - 1;
            break;
          }
          told += 1;
        }
        if (events.length === batchSize) through = event.position;
      }
      await storage.recipients.caughtUp(recipient.port, through);
    }
    return told;
  },
});
