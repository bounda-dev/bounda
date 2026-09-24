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
import { errorDetails } from "../shared/retry.ts";
import { ATTRIBUTES, traced } from "../telemetry.ts";

/**
 * What projecting needs to know about a read model: its name and its projections by event type.
 */
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

/**
 * How long a batch may take, on which clock.
 */
export interface ProjectionBudget {
  readonly clock: Clock;
  readonly maxMs: number;
}

export interface ProjectBatchFunction {
  (args: ProjectBatchArgs): Promise<number>;
}

/**
 * Hands the events to the projections that declare their types, in order, with the `table` and
 * `client` given; events nobody projects are skipped. Resolves to how many events it got through:
 * all of them, or fewer when the budget ran out first, never none. The first projection that
 * throws stops the batch: it rejects with a `PartialBatchError` that says how many events went
 * through before the one that failed and carries the projection's error as its `cause`.
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
    for (const projection of readModel.projectionsByEvent[event.type] ?? []) {
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

/**
 * The checkpoint name of a read model's projections.
 */
export const projectionSubscriberName: ProjectionSubscriberNameFunction = (readModel) =>
  `projection:${readModel}`;

/**
 * One subscriber per read model, checkpointed in the read model's own database. Each batch runs
 * inside `ports.transact`: the projections write through the transaction and the checkpoint
 * advances in it, so the batch and the checkpoint past it commit together or not at all, and only
 * one process at a time applies a read model's batches. A batch that outlasts its budget commits
 * the events it got through and leaves the rest for the next delivery. A projection that throws
 * rolls the whole batch back; the events before the one that failed are then committed on their
 * own, and the checkpoint stops right before it: a read model cannot skip an event, so that event
 * is redelivered, onto the rows as they were, until the projection succeeds. Every event is
 * applied exactly once, provided the projection writes nowhere but its read model.
 */
export const createProjectionSubscriber: CreateProjectionSubscriberFunction = ({
  readModel,
  logger,
  budget,
}) => {
  const name = projectionSubscriberName(readModel.name);
  const { ports } = readModel;
  return createCheckpointedSubscriber<ProjectionClaim>({
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
};
