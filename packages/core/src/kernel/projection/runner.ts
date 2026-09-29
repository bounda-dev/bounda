import type { ReadClient, Table } from "../../adapter/ports/table.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import {
  type CheckpointClaim,
  type CheckpointedSubscriber,
  createCheckpointedSubscriber,
  PartialBatchError,
} from "../dispatch/delivery.ts";
import type { ProjectionRuntime, ReadModelRuntime } from "../read-model/build-read-models.ts";
import { qualifiedEventType } from "../shared/qualified-event.ts";
import { errorDetails } from "../shared/retry.ts";
import { ATTRIBUTES, traced } from "../telemetry.ts";

export interface ProjectionTarget {
  readonly name: string;
  readonly projectionsByEvent: Readonly<Record<string, readonly ProjectionRuntime[]>>;
}

export interface ProjectBatchArgs {
  readonly readModel: ProjectionTarget;
  readonly events: readonly StoredEvent[];
  readonly table: Table<Record<string, unknown>>;
  readonly client: ReadClient<Record<string, unknown>>;
  readonly logger: Logger;
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

/**
 * Resolves to how many events it got through: fewer when the budget ran out, never none. A
 * projection that throws rejects the batch with a `PartialBatchError`.
 */
export const projectBatch: ProjectBatchFunction = async ({
  readModel,
  events,
  table,
  client,
  logger,
  budget: { clock, maxMs },
}) => {
  const started = clock.now().getTime();
  let done = 0;
  for (const event of events) {
    if (done > 0 && clock.now().getTime() - started >= maxMs) return done;
    const qualified = qualifiedEventType(event.aggregateType, event.type);
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
          },
          run: async () => {
            await projection.project({ event, table, client });
          },
        });
      } catch (error) {
        logger.error("projection failed", {
          readModel: readModel.name,
          projection: projection.key,
          eventId: event.id,
          eventType: event.type,
          ...errorDetails(error),
        });
        throw new PartialBatchError(done, error);
      }
    }
    done += 1;
  }
  return done;
};

interface ProjectionClaim extends CheckpointClaim {
  readonly table: Table<Record<string, unknown>>;
  readonly client: ReadClient<Record<string, unknown>>;
}

export interface CreateProjectionSubscriberArgs {
  readonly readModel: ReadModelRuntime;
  readonly logger: Logger;
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
  logger,
  budget,
}) => {
  const name = projectionSubscriberName(readModel.name);
  const { ports } = readModel;
  const subscriber = createCheckpointedSubscriber<ProjectionClaim>({
    name,
    kind: "projection",
    position: () => ports.checkpointStore.get(name),
    claim: ({ wait, work }) =>
      ports.transact({
        subscriber: name,
        wait,
        work: (transaction) =>
          work({
            get: () => transaction.checkpointStore.get(name),
            compareAndSet: (expected, position) =>
              transaction.checkpointStore.compareAndSet(name, expected, position),
            table: transaction.table,
            client: transaction.client,
          }),
      }),
    process: (events, { table, client }) =>
      projectBatch({ readModel, events, table, client, logger, budget }),
    logger,
  });
  return {
    ...subscriber,
    reactsTo: (qualified) => (readModel.projectionsByEvent[qualified]?.length ?? 0) > 0,
  };
};
