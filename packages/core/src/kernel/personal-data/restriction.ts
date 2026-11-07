import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredDispatch } from "../../contracts/command.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import {
  BOUNDA_AGGREGATE,
  PROCESSING_RESTRICTED_EVENT,
  PROCESSING_RESTRICTION_LIFTED_EVENT,
  type ProcessingRestrictedPayload,
  type ProcessingRestrictionLiftedPayload,
} from "../../modules/bounda-events.ts";
import { RETRY_RESTRICTED_COMMAND, retryRestrictedKey } from "../command/pipeline.ts";
import { appendSystemEvent } from "../system-events.ts";
import { checkPersonId, transactRetrying } from "./transact.ts";

export interface ProcessingRestrictionArgs {
  readonly storage: Storage;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly concurrencyRetries: number;
  readonly personId: string;
}

export interface ProcessingRestrictionFunction {
  (args: ProcessingRestrictionArgs): Promise<StoredDispatch>;
}

interface Change {
  readonly subject: "restrict" | "unrestrict";
  readonly type: string;
  readonly logged: string;
  /**
   * Resolves to whether the row changed; nothing is appended otherwise.
   */
  readonly apply: (transaction: StorageTransaction, now: Date) => Promise<boolean>;
  /**
   * Staged after the event, in the same transaction.
   */
  readonly after?: (transaction: StorageTransaction, event: StoredEvent) => Promise<void>;
}

// A change that does nothing still answers with the stream's version, as a command without
// events does, so a caller waits on nothing.
const change = async (
  { storage, ids, clock, logger, concurrencyRetries, personId }: ProcessingRestrictionArgs,
  { subject, type, logged, apply, after }: Change,
): Promise<StoredDispatch> => {
  checkPersonId(personId, subject);
  const correlationId = ids.next();
  const { changed, version, event } = await transactRetrying({
    storage,
    concurrencyRetries,
    work: async (transaction) => {
      const now = clock.now();
      if (!(await apply(transaction, now))) {
        const { version } = await transaction.eventStore.load({
          aggregateType: BOUNDA_AGGREGATE,
          aggregateId: personId,
          fromVersion: Number.MAX_SAFE_INTEGER,
        });
        return { changed: false, version, event: null };
      }
      const payload: ProcessingRestrictedPayload | ProcessingRestrictionLiftedPayload = {
        personId,
      };
      const event = await appendSystemEvent({
        eventStore: transaction.eventStore,
        ids,
        clock,
        aggregateType: BOUNDA_AGGREGATE,
        aggregateId: personId,
        type,
        payload,
        person: personId,
        context: { correlationId, causationId: correlationId, depth: 0 },
      });
      await after?.(transaction, event);
      return { changed: true, version: event.version, event };
    },
  });
  logger.info(logged, { personId, changed });
  return {
    scheduled: false,
    aggregateType: BOUNDA_AGGREGATE,
    aggregateId: personId,
    version,
    eventIds: event === null ? [] : [event.id],
    eventTypes: event === null ? [] : [event.type],
    position: event?.position ?? 0,
  };
};

/**
 * Restricts the processing of the person's data: writes their row and appends
 * `ProcessingRestricted` to their stream, in one transaction. Restricting a person restricted
 * already changes nothing and appends nothing.
 */
export const restrictProcessing: ProcessingRestrictionFunction = (args) =>
  change(args, {
    subject: "restrict",
    type: PROCESSING_RESTRICTED_EVENT,
    logged: "processing restricted",
    apply: (transaction, now) => transaction.persons.restrict(args.personId, now),
  });

/**
 * Lifts the restriction: clears the row, appends `ProcessingRestrictionLifted` and schedules the
 * entry that retries the dead letters the restriction caused, in one transaction. Lifting for a
 * person not restricted changes nothing and appends nothing.
 */
export const liftProcessingRestriction: ProcessingRestrictionFunction = (args) =>
  change(args, {
    subject: "unrestrict",
    type: PROCESSING_RESTRICTION_LIFTED_EVENT,
    logged: "processing restriction lifted",
    apply: (transaction) => transaction.persons.unrestrict(args.personId),
    after: (transaction, event) =>
      transaction.scheduler.schedule({
        dedupeKey: retryRestrictedKey(args.personId),
        command: {
          type: RETRY_RESTRICTED_COMMAND,
          aggregateId: args.personId,
          payload: { personId: args.personId },
        },
        executeAt: new Date(event.timestamp),
        context: { correlationId: event.metadata.correlationId, causationId: event.id, depth: 0 },
      }),
  });
