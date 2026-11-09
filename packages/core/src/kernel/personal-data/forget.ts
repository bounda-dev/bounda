import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredDispatch } from "../../contracts/command.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  type PersonalDataForgottenPayload,
  type PersonalDataForgottenReason,
} from "../../modules/bounda-events.ts";
import { scheduledCommandId } from "../command/pipeline.ts";
import { actedBy, startedBy } from "../shared/causation.ts";
import { appendSystemEvent } from "../system-events.ts";
import type { ForgetIntention, ForgetIntentions } from "./intention.ts";
import { checkPersonId, transactRetrying } from "./transact.ts";

export interface ForgetWithinArgs {
  readonly transaction: StorageTransaction;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly personId: string;
  readonly intention: ForgetIntention;
  readonly context: CausationContext;
  /**
   * The caller found already, in this transaction, the intention's event not held and the
   * person's key named by it.
   */
  readonly checked?: boolean;
}

export interface Forgotten {
  readonly hadKey: boolean;
  readonly payload: PersonalDataForgottenPayload;
  readonly event: StoredEvent;
}

/**
 * The forgetting the intention names is in the store already, committed by a reconciliation
 * meanwhile.
 */
export interface HeldForgetting {
  readonly held: StoredEvent;
}

/**
 * The person holds a key the intention does not name: given to them after it was written.
 */
export const STALE_INTENTION: "stale" = "stale";

export type ForgetOutcome = Forgotten | HeldForgetting | typeof STALE_INTENTION;

export interface ForgetWithinFunction {
  (args: ForgetWithinArgs): Promise<ForgetOutcome>;
}

/**
 * Removes the person's key and appends `PersonalDataForgotten` to their stream, with the id, time
 * and reason of the intention, on the transaction given: whoever reads the event finds the fields
 * gone already. The scheduled commands and dead letters that hold the person's data go in the same
 * transaction, and the event names them. A person without a key is forgotten all the same, since
 * read models may hold what their events carried in the clear.
 */
export const forgetWithin: ForgetWithinFunction = async ({
  transaction,
  ids,
  clock,
  personId,
  intention,
  context,
  checked = false,
}) => {
  const { fingerprints } = intention;
  if (fingerprints !== undefined && !checked) {
    const held = await transaction.eventStore.readOne({
      aggregateType: BOUNDA_AGGREGATE,
      aggregateId: personId,
      eventId: intention.eventId,
    });
    if (held !== null) return { held };
  }
  const key = await transaction.personalKeys.get(personId);
  if (
    !checked &&
    key !== null &&
    fingerprints !== undefined &&
    !fingerprints.includes(key.fingerprint)
  ) {
    return STALE_INTENTION;
  }
  // The key goes first: a snapshot written beside the transaction then either waits for it and
  // is forgotten with the rest, or finds no key and is never written. The scheduled commands go
  // before the dead letters: a worker giving one up writes its letter and settles its claim
  // together, so either this waits for it and then finds the letter, or the claim is lost and the
  // letter rolls back.
  const hadKey = await transaction.personalKeys.remove(personId);
  await transaction.snapshotStore.forget(personId);
  await transaction.idempotencyStore.forget(personId);
  const cancelled = await transaction.scheduler.forget(personId);
  const letters = await transaction.deadLetterStore.forget(personId);
  const payload: PersonalDataForgottenPayload = {
    personId,
    reason: intention.reason,
    fingerprints: key === null ? [] : [key.fingerprint],
    cancelledCommands: cancelled.map(({ dedupeKey, command }) => ({
      commandId: scheduledCommandId(dedupeKey) ?? dedupeKey,
      type: command.type,
    })),
    removedDeadLetters: letters.map(({ id, handler }) => ({ id, commandType: handler })),
  };
  const event = await appendSystemEvent({
    eventStore: transaction.eventStore,
    ids,
    clock,
    aggregateType: BOUNDA_AGGREGATE,
    aggregateId: personId,
    type: PERSONAL_DATA_FORGOTTEN_EVENT,
    payload,
    context,
    person: personId,
    identity: { id: intention.eventId, timestamp: intention.forgottenAt },
  });
  return { hadKey, payload, event };
};

export interface ForgetIntendedArgs {
  readonly storage: Pick<Storage, "transact" | "personalKeys">;
  readonly intentions: ForgetIntentions;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly concurrencyRetries: number;
  readonly personId: string;
  readonly reason: PersonalDataForgottenReason;
  readonly context: CausationContext;
}

export interface ForgetIntendedFunction {
  (args: ForgetIntendedArgs): Promise<Forgotten | HeldForgetting>;
}

/**
 * Records the intention, then forgets in a transaction of its own. A key given to the person
 * between the two takes a new intention that names it: each round needs a forgetting of the same
 * person to commit in between, so the rounds end when those do.
 */
export const forgetIntended: ForgetIntendedFunction = async ({
  storage,
  intentions,
  ids,
  clock,
  concurrencyRetries,
  personId,
  reason,
  context,
}) => {
  for (;;) {
    const intention = await intentions.intend({ personId, reason, keys: storage.personalKeys });
    const outcome = await transactRetrying({
      storage,
      concurrencyRetries,
      work: (transaction) =>
        forgetWithin({ transaction, ids, clock, personId, intention, context }),
    });
    if (outcome !== STALE_INTENTION) return outcome;
  }
};

export interface LogForgottenFunction {
  (logger: Logger, forgotten: Forgotten): void;
}

export const logForgotten: LogForgottenFunction = (logger, { hadKey, payload, event }) => {
  logger.info("personal data forgotten", {
    personId: payload.personId,
    reason: payload.reason,
    hadKey,
    cancelledCommands: payload.cancelledCommands.length,
    removedDeadLetters: payload.removedDeadLetters.length,
    ...actedBy(event.metadata.actor),
  });
};

export interface ForgottenDispatchFunction {
  (event: StoredEvent): StoredDispatch;
}

export const forgottenDispatch: ForgottenDispatchFunction = (event) => ({
  scheduled: false,
  aggregateType: BOUNDA_AGGREGATE,
  aggregateId: event.aggregateId,
  version: event.version,
  eventIds: [event.id],
  eventTypes: [event.type],
  position: event.position,
});

export interface ForgetPersonalDataArgs {
  readonly storage: Storage;
  readonly intentions: ForgetIntentions;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly concurrencyRetries: number;
  readonly personId: string;
  readonly actor?: string | undefined;
}

export interface ForgetPersonalDataFunction {
  (args: ForgetPersonalDataArgs): Promise<StoredDispatch>;
}

/**
 * `forget` of a client: `forgetIntended`, as a request of the person.
 */
export const forgetPersonalData: ForgetPersonalDataFunction = async ({
  storage,
  intentions,
  ids,
  clock,
  logger,
  concurrencyRetries,
  personId,
  actor,
}) => {
  checkPersonId(personId, "forget");
  const correlationId = ids.next();
  const forgotten = await forgetIntended({
    storage,
    intentions,
    ids,
    clock,
    concurrencyRetries,
    personId,
    reason: "requested",
    context: startedBy(correlationId, actor),
  });
  if ("held" in forgotten) return forgottenDispatch(forgotten.held);
  logForgotten(logger, forgotten);
  return forgottenDispatch(forgotten.event);
};
