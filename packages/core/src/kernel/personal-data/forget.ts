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
 * transaction: whoever reads the event finds the fields gone already. A person without a key is
 * forgotten all the same, since read models may hold what their events carried in the clear.
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
  const payload: PersonalDataForgottenPayload = { personId };
  for (let attempt = 0; ; attempt += 1) {
    try {
      // The key goes first: a snapshot written beside the transaction then either waits for it
      // and is forgotten with the rest, or finds no key and is never written.
      const { removed, stored } = await storage.transact(async (transaction) => {
        const hadKey = await transaction.personalKeys.remove(personId);
        await transaction.snapshotStore.forget(personId);
        return {
          removed: hadKey,
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
      logger.info("personal data forgotten", { personId, hadKey: removed });
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
