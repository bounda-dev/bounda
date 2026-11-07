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
import { checkPersonId, transactRetrying } from "./transact.ts";

export interface ForgetWithinArgs {
  readonly transaction: StorageTransaction;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly personId: string;
  readonly reason: PersonalDataForgottenReason;
  readonly context: CausationContext;
}

export interface Forgotten {
  readonly hadKey: boolean;
  readonly payload: PersonalDataForgottenPayload;
  readonly event: StoredEvent;
}

export interface ForgetWithinFunction {
  (args: ForgetWithinArgs): Promise<Forgotten>;
}

/**
 * Removes the person's key and appends `PersonalDataForgotten` to their stream, on the
 * transaction given: whoever reads the event finds the fields gone already. The scheduled
 * commands and dead letters that hold the person's data go in the same transaction, and the event
 * names them. A person without a key is forgotten all the same, since read models may hold what
 * their events carried in the clear.
 */
export const forgetWithin: ForgetWithinFunction = async ({
  transaction,
  ids,
  clock,
  personId,
  reason,
  context,
}) => {
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
    reason,
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
  });
  return { hadKey, payload, event };
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
 * `forget` of a client: `forgetWithin` in a transaction of its own, as a request of the person.
 */
export const forgetPersonalData: ForgetPersonalDataFunction = async ({
  storage,
  ids,
  clock,
  logger,
  concurrencyRetries,
  personId,
  actor,
}) => {
  checkPersonId(personId, "forget");
  const correlationId = ids.next();
  const forgotten = await transactRetrying({
    storage,
    concurrencyRetries,
    work: (transaction) =>
      forgetWithin({
        transaction,
        ids,
        clock,
        personId,
        reason: "requested",
        context: startedBy(correlationId, actor),
      }),
  });
  logForgotten(logger, forgotten);
  return forgottenDispatch(forgotten.event);
};
