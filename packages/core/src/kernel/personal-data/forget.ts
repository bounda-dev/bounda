import type { Storage } from "../../adapter/adapter.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredDispatch } from "../../contracts/command.ts";
import { ConcurrencyError, ValidationError } from "../../contracts/errors.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  type PersonalDataForgottenPayload,
} from "../../modules/bounda-events.ts";
import { scheduledCommandId } from "../command/pipeline.ts";
import { appendSystemEvent } from "../system-events.ts";

export interface ForgetPersonalDataArgs {
  readonly storage: Storage;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly concurrencyRetries: number;
  readonly personId: string;
}

export interface ForgetPersonalDataFunction {
  (args: ForgetPersonalDataArgs): Promise<StoredDispatch>;
}

/**
 * Removes the person's key and appends `PersonalDataForgotten` to their stream, in one
 * transaction: whoever reads the event finds the fields gone already. The scheduled commands and
 * dead letters that hold the person's data go in the same transaction, and the event names them.
 * A person without a key is forgotten all the same, since read models may hold what their events
 * carried in the clear.
 */
export const forgetPersonalData: ForgetPersonalDataFunction = async ({
  storage,
  ids,
  clock,
  logger,
  concurrencyRetries,
  personId,
}) => {
  if (typeof personId !== "string" || personId === "") {
    throw new ValidationError("forget needs the id of the person to forget", [
      { path: ["personId"], message: "Expected a non-empty string" },
    ]);
  }
  const correlationId = ids.next();
  for (let attempt = 0; ; attempt += 1) {
    try {
      // The key goes first: a snapshot written beside the transaction then either waits for it
      // and is forgotten with the rest, or finds no key and is never written. The scheduled
      // commands go before the dead letters: a worker giving one up writes its letter and settles
      // its claim together, so either this waits for it and then finds the letter, or the claim
      // is lost and the letter rolls back.
      const { removed, payload, stored } = await storage.transact(async (transaction) => {
        const hadKey = await transaction.personalKeys.remove(personId);
        await transaction.snapshotStore.forget(personId);
        await transaction.idempotencyStore.forget(personId);
        const cancelled = await transaction.scheduler.forget(personId);
        const letters = await transaction.deadLetterStore.forget(personId);
        const payload: PersonalDataForgottenPayload = {
          personId,
          cancelledCommands: cancelled.map(({ dedupeKey, command }) => ({
            commandId: scheduledCommandId(dedupeKey) ?? dedupeKey,
            type: command.type,
          })),
          removedDeadLetters: letters.map(({ id, handler }) => ({ id, commandType: handler })),
        };
        return {
          removed: hadKey,
          payload,
          stored: await appendSystemEvent({
            eventStore: transaction.eventStore,
            ids,
            clock,
            aggregateType: BOUNDA_AGGREGATE,
            aggregateId: personId,
            type: PERSONAL_DATA_FORGOTTEN_EVENT,
            payload,
            context: { correlationId, causationId: correlationId, depth: 0 },
          }),
        };
      });
      logger.info("personal data forgotten", {
        personId,
        hadKey: removed,
        cancelledCommands: payload.cancelledCommands.length,
        removedDeadLetters: payload.removedDeadLetters.length,
      });
      return {
        scheduled: false,
        aggregateType: BOUNDA_AGGREGATE,
        aggregateId: personId,
        version: stored.version,
        eventIds: [stored.id],
        eventTypes: [stored.type],
        position: stored.position,
      };
    } catch (error) {
      if (!(error instanceof ConcurrencyError) || attempt >= concurrencyRetries) throw error;
    }
  }
};
