import type { ReadModelTransaction } from "../../adapter/adapter.ts";
import type { SealedValue } from "../../adapter/storage/personal-key-store.ts";
import type { ErrorText } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  PERSONAL_DATA_REDACTED_EVENT,
} from "../../modules/bounda-events.ts";
import {
  type CheckpointClaim,
  type CheckpointedSubscriber,
  createCheckpointedSubscriber,
  PartialBatchError,
} from "../dispatch/delivery.ts";
import type { BlindIndexer } from "../personal-data/blind-index.ts";
import { openedUnder } from "../personal-data/event-store.ts";
import type { PersonalKeys } from "../personal-data/wrapped-keys.ts";
import type { ProjectionRuntime, ReadModelRuntime } from "../read-model/build-read-models.ts";
import { sealedClient } from "../read-model/sealed-client.ts";
import { applyForgetting, isForgetting } from "../read-model/sealed-forgetting.ts";
import { applyRedaction, isRedaction } from "../read-model/sealed-redaction.ts";
import type { SealedLayout, SealingContext } from "../read-model/sealed-rows.ts";
import { settleUnsettled } from "../read-model/sealed-settle.ts";
import { sealedTable } from "../read-model/sealed-table.ts";
import {
  createSealingKeyRing,
  KeysMissingError,
  type SealingKeys,
} from "../read-model/sealing-keys.ts";
import { qualifiedEventType } from "../shared/qualified-event.ts";
import { ATTRIBUTES, actorAttribute, traced } from "../telemetry.ts";

export interface ProjectionTarget {
  readonly name: string;
  readonly projectionsByEvent: Readonly<Record<string, readonly ProjectionRuntime[]>>;
}

/**
 * How a batch's writes are sealed: the read model's layout, the keys fetched for the batch, and
 * the database's blind indexes.
 */
export interface BatchSealing {
  readonly layout: SealedLayout;
  readonly keys: SealingKeys;
  readonly indexer: BlindIndexer | null;
  /**
   * The old values each redaction of the batch kept, by the id of its `PersonalDataRedacted`.
   */
  readonly redacted?: RedactedValues;
}

/**
 * The old values redactions kept, sealed under their persons' keys, by the id of each
 * `PersonalDataRedacted`.
 */
export type RedactedValues = ReadonlyMap<string, readonly SealedValue[]>;

export interface ProjectBatchArgs {
  readonly readModel: ProjectionTarget;
  readonly events: readonly StoredEvent[];
  /**
   * The read model's transaction, as its adapter gives it, on the stored fields.
   */
  readonly transaction: Pick<ReadModelTransaction, "table" | "client" | "unsettled">;
  readonly sealing: BatchSealing;
  readonly logger: Logger;
  readonly errorText: ErrorText;
  /**
   * Stop after `maxMs` on `clock`, once the event in hand is projected.
   */
  readonly budget: ProjectionBudget;
}

export interface ProjectionBudget {
  readonly clock: Clock;
  readonly maxMs: number;
}

export interface ProjectBatchFunction {
  (args: ProjectBatchArgs): Promise<number>;
}

export interface BatchPersonsFunction {
  (events: readonly StoredEvent[]): readonly string[];
}

/**
 * The persons whose keys a batch is likely to seal or open with: those its events were opened for,
 * and those a forgetting in it names, whose kept keys say which category each of its fingerprints
 * is.
 */
export const batchPersons: BatchPersonsFunction = (events) => [
  ...new Set(
    events.flatMap((event) => [
      ...openedUnder(event).map(({ person }) => person),
      ...(isForgetting(event) || isRedaction(event)
        ? [(event.payload as { personId: string }).personId]
        : []),
    ]),
  ),
];

/**
 * Resolves to how many events it got through: fewer when the budget ran out, never none. A
 * projection that throws rejects the batch with a `PartialBatchError`, but a `KeysMissingError`,
 * which names every person of the batch, rejects it as it is. Values written through `client.raw`
 * into personal fields are sealed before it resolves.
 */
export const projectBatch: ProjectBatchFunction = async ({
  readModel,
  events,
  transaction,
  sealing,
  logger,
  errorText,
  budget: { clock, maxMs },
}) => {
  const started = clock.now().getTime();
  let current: StoredEvent | null = null;
  let raw = false;
  const context: SealingContext = { ...sealing, event: () => current };
  const table = sealedTable({ context, table: transaction.table });
  const client = sealedClient({
    context,
    client: transaction.client,
    onRaw: () => {
      raw = true;
    },
  });
  const settled = async (count: number): Promise<number> => {
    if (raw && sealing.layout.personal.length > 0) await settleUnsettled({ context, transaction });
    return count;
  };
  let done = 0;
  for (const event of events) {
    if (done > 0 && clock.now().getTime() - started >= maxMs) return settled(done);
    current = event;
    const qualified = qualifiedEventType(event.aggregateType, event.type);
    try {
      if (isForgetting(event) && sealing.layout.personal.length > 0) {
        await applyForgetting({
          layout: sealing.layout,
          table: transaction.table,
          keys: sealing.keys,
          event,
        });
      }
      if (isRedaction(event)) {
        await applyRedaction({
          context,
          table: transaction.table,
          event,
          values: sealing.redacted?.get(event.id) ?? [],
        });
      }
    } catch (error) {
      if (error instanceof KeysMissingError) {
        throw new KeysMissingError([...error.persons, ...batchPersons(events)]);
      }
      throw new PartialBatchError(done, error);
    }
    for (const projection of readModel.projectionsByEvent[qualified] ?? []) {
      try {
        await traced({
          name: `bounda.projection ${readModel.name}.${projection.key}`,
          attributes: {
            [ATTRIBUTES.readModel]: readModel.name,
            [ATTRIBUTES.projection]: projection.key,
            [ATTRIBUTES.eventId]: event.id,
            [ATTRIBUTES.eventType]: event.type,
            [ATTRIBUTES.aggregateType]: event.aggregateType,
            [ATTRIBUTES.aggregateId]: event.aggregateId,
            [ATTRIBUTES.correlationId]: event.metadata.correlationId,
            ...actorAttribute(event.metadata.actor),
          },
          errorText,
          run: async () => {
            await projection.project({ event, table, client });
          },
        });
      } catch (error) {
        if (error instanceof KeysMissingError) {
          throw new KeysMissingError([...error.persons, ...batchPersons(events)]);
        }
        logger.error("projection failed", {
          readModel: readModel.name,
          projection: projection.key,
          eventId: event.id,
          eventType: event.type,
          error,
        });
        throw new PartialBatchError(done, error);
      }
    }
    done += 1;
  }
  return settled(done);
};

interface ProjectionClaim extends CheckpointClaim {
  readonly transaction: Pick<ReadModelTransaction, "table" | "client" | "unsettled">;
  readonly keys: SealingKeys;
  readonly redacted: RedactedValues;
}

/**
 * What sealing needs from the app: the persons' keys and the database's blind indexes.
 */
export interface SealingSource {
  readonly keys: Pick<PersonalKeys, "heldAllOf">;
  readonly indexer: BlindIndexer | null;
  /**
   * Where the old values a redaction kept are read, by its event's id.
   */
  readonly redactions: (eventId: string) => Promise<readonly SealedValue[]>;
}

export interface WithKeysArgs<T> {
  readonly keys: SealingSource["keys"];
  readonly events: readonly StoredEvent[];
  readonly redactions: SealingSource["redactions"];
  readonly run: (keys: SealingKeys, redacted: RedactedValues) => Promise<T>;
}

export interface WithKeysFunction {
  <T>(args: WithKeysArgs<T>): Promise<T>;
}

/**
 * Runs `run`, which opens a read model's transaction, with the keys of the batch's persons fetched
 * first; when it needs others, it runs again once they are fetched, outside the transaction it
 * undid.
 */
export const withKeys: WithKeysFunction = async ({ keys, events, redactions, run }) => {
  const ring = createSealingKeyRing({ keys, fetching: false });
  await ring.fetch(batchPersons(events));
  const redacted = new Map<string, readonly SealedValue[]>();
  for (const event of events.filter(isRedaction)) {
    redacted.set(event.id, await redactions(event.id));
  }
  for (;;) {
    try {
      return await run(ring, redacted);
    } catch (error) {
      if (!(error instanceof KeysMissingError)) throw error;
      await ring.fetch(error.persons);
    }
  }
};

export interface CreateProjectionSubscriberArgs {
  readonly readModel: ReadModelRuntime;
  readonly sealing: SealingSource;
  readonly logger: Logger;
  readonly errorText: ErrorText;
  readonly budget: ProjectionBudget;
}

export interface CreateProjectionSubscriberFunction {
  (args: CreateProjectionSubscriberArgs): CheckpointedSubscriber;
}

export interface ProjectionSubscriberNameFunction {
  (readModel: string): string;
}

export const projectionSubscriberName: ProjectionSubscriberNameFunction = (readModel) =>
  `projection:${readModel}`;

/**
 * The batch and the checkpoint past it commit in one transaction of the read model's database, so
 * every event is applied exactly once, provided the projection writes nowhere but its read model.
 * An event whose projection throws is never skipped: it is redelivered until it succeeds.
 */
export const createProjectionSubscriber: CreateProjectionSubscriberFunction = ({
  readModel,
  sealing,
  logger,
  errorText,
  budget,
}) => {
  const name = projectionSubscriberName(readModel.name);
  const { storage, layout } = readModel;
  const forgets = layout.personal.length > 0;
  const subscriber = createCheckpointedSubscriber<ProjectionClaim>({
    name,
    kind: "projection",
    position: () => storage.checkpointStore.get(name),
    claim: ({ wait, events, work }) =>
      withKeys({
        keys: sealing.keys,
        events,
        redactions: sealing.redactions,
        run: (keys, redacted) =>
          storage.transact({
            subscriber: name,
            wait,
            work: (transaction) =>
              work({
                get: () => transaction.checkpointStore.get(name),
                compareAndSet: (expected, position) =>
                  transaction.checkpointStore.compareAndSet(name, expected, position),
                transaction,
                keys,
                redacted,
              }),
          }),
      }),
    process: (events, { transaction, keys, redacted }) =>
      projectBatch({
        readModel,
        events,
        transaction,
        sealing: { layout, keys, indexer: sealing.indexer, redacted },
        logger,
        errorText,
        budget,
      }),
    logger,
    errorText,
  });
  return {
    ...subscriber,
    reactsTo: (qualified) =>
      (readModel.projectionsByEvent[qualified]?.length ?? 0) > 0 ||
      (forgets && (qualified === FORGOTTEN || qualified === REDACTED)),
  };
};

const FORGOTTEN = qualifiedEventType(BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT);
const REDACTED = qualifiedEventType(BOUNDA_AGGREGATE, PERSONAL_DATA_REDACTED_EVENT);
