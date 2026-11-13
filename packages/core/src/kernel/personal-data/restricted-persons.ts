import type { Adapter } from "../../adapter/adapter.ts";
import type { RestrictedPersonsStore } from "../../adapter/storage/restricted-persons.ts";
import type { ErrorText } from "../../config/types.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  type PersonalDataForgottenPayload,
  PROCESSING_RESTRICTED_EVENT,
  PROCESSING_RESTRICTION_LIFTED_EVENT,
  type ProcessingRestrictedPayload,
  type ProcessingRestrictionLiftedPayload,
} from "../../modules/bounda-events.ts";
import {
  type CheckpointClaim,
  type CheckpointedSubscriber,
  createCheckpointedSubscriber,
} from "../dispatch/delivery.ts";
import type { ReadModelRuntime } from "../read-model/build-read-models.ts";
import { qualifiedEventType } from "../shared/qualified-event.ts";

const REACTS_TO: ReadonlySet<string> = new Set(
  [
    PROCESSING_RESTRICTED_EVENT,
    PROCESSING_RESTRICTION_LIFTED_EVENT,
    PERSONAL_DATA_FORGOTTEN_EVENT,
  ].map((type) => qualifiedEventType(BOUNDA_AGGREGATE, type)),
);

export interface RestrictedPersonsSubscriberNameFunction {
  (readModel: string): string;
}

/**
 * Named after the read model whose storage it writes through: one per database.
 */
export const restrictedPersonsSubscriberName: RestrictedPersonsSubscriberNameFunction = (
  readModel,
) => `restrictions:${readModel}`;

export interface ApplyToRestrictedPersonsFunction {
  (store: RestrictedPersonsStore, event: StoredEvent): Promise<void>;
}

export const applyToRestrictedPersons: ApplyToRestrictedPersonsFunction = async (store, event) => {
  if (!REACTS_TO.has(qualifiedEventType(event.aggregateType, event.type))) return;
  const { personId } = event.payload as { readonly personId: string };
  if (!(await store.advance(personId, event.position))) return;
  switch (event.type) {
    case PROCESSING_RESTRICTED_EVENT:
    case PROCESSING_RESTRICTION_LIFTED_EVENT: {
      const { personId, restrictions } = event.payload as
        | ProcessingRestrictedPayload
        | ProcessingRestrictionLiftedPayload;
      await store.request(personId, restrictions);
      return;
    }
    case PERSONAL_DATA_FORGOTTEN_EVENT: {
      const { personId, categories, retained, expired } =
        event.payload as PersonalDataForgottenPayload;
      await store.release(personId, [...categories, ...expired]);
      await store.retain(personId, retained);
      return;
    }
    default:
      return;
  }
};

interface RestrictedPersonsClaim extends CheckpointClaim {
  readonly restrictedPersons: RestrictedPersonsStore;
}

export interface CreateRestrictedPersonsSubscriberArgs {
  /**
   * A read model of the database, whose transactions the copy is written in.
   */
  readonly readModel: Pick<ReadModelRuntime, "name" | "storage">;
  readonly logger: Logger;
  readonly errorText: ErrorText;
}

export interface CreateRestrictedPersonsSubscriberFunction {
  (args: CreateRestrictedPersonsSubscriberArgs): CheckpointedSubscriber;
}

/**
 * Keeps a database's copy of who is restricted from the stream, in the transaction that moves its
 * checkpoint, as a projection keeps its rows: a query of a read model there leaves out the rows it
 * names. Waited for, as the read models are, by `catchUpReadModels({ through })` of a `restrict`,
 * `unrestrict` or `forget`.
 */
export const createRestrictedPersonsSubscriber: CreateRestrictedPersonsSubscriberFunction = ({
  readModel,
  logger,
  errorText,
}) => {
  const name = restrictedPersonsSubscriberName(readModel.name);
  const { storage } = readModel;
  const subscriber = createCheckpointedSubscriber<RestrictedPersonsClaim>({
    name,
    kind: "projection",
    position: () => storage.checkpointStore.get(name),
    claim: ({ wait, work }) =>
      storage.transact({
        subscriber: name,
        wait,
        work: (transaction) =>
          work({
            get: () => transaction.checkpointStore.get(name),
            compareAndSet: (expected, position) =>
              transaction.checkpointStore.compareAndSet(name, expected, position),
            restrictedPersons: transaction.restrictedPersons,
          }),
      }),
    process: async (events, { restrictedPersons }) => {
      for (const event of events) await applyToRestrictedPersons(restrictedPersons, event);
      return events.length;
    },
    logger,
    errorText,
  });
  return { ...subscriber, reactsTo: (qualified) => REACTS_TO.has(qualified) };
};

export interface RestrictedPersonsHostsArgs {
  readonly readModels: readonly Pick<ReadModelRuntime, "name" | "storage" | "personalData">[];
  /**
   * The adapter each read model lives on, which tells their databases apart.
   */
  readonly adapterOf: (readModel: string) => Adapter;
}

export interface RestrictedPersonsHostsFunction {
  (args: RestrictedPersonsHostsArgs): readonly Pick<ReadModelRuntime, "name" | "storage">[];
}

/**
 * One read model per database that holds a read model with a field marked `.person()`, the first
 * by name: the copy of that database is written through it. A database without one needs no copy.
 */
export const restrictedPersonsHosts: RestrictedPersonsHostsFunction = ({
  readModels,
  adapterOf,
}) => {
  const hosts = new Map<Adapter, Pick<ReadModelRuntime, "name" | "storage">>();
  for (const readModel of [...readModels].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (readModel.personalData === null) continue;
    const adapter = adapterOf(readModel.name);
    if (!hosts.has(adapter)) hosts.set(adapter, readModel);
  }
  return [...hosts.values()];
};
