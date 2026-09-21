import type { Logger } from "../../contracts/logger.ts";
import type { Subscriber } from "../dispatch/dispatcher.ts";
import type { ReadModelRuntime } from "../read-model/build-read-models.ts";
import { errorDetails } from "../shared/retry.ts";

export interface CreateProjectionSubscriberArgs {
  readonly readModel: ReadModelRuntime;
  readonly logger: Logger;
}

export interface CreateProjectionSubscriberFunction {
  (args: CreateProjectionSubscriberArgs): Subscriber;
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
 * One subscriber per read model. Every event is handed to the projections that declare its type;
 * events nobody projects are skipped. A projection that throws holds the checkpoint: a read model
 * cannot skip an event, so the batch is redelivered until the projection succeeds. Projections
 * must therefore be idempotent, which `table.upsert` gives for free.
 */
export const createProjectionSubscriber: CreateProjectionSubscriberFunction = ({
  readModel,
  logger,
}) => ({
  name: projectionSubscriberName(readModel.name),
  kind: "projection",
  process: async (events) => {
    for (const event of events) {
      for (const projection of readModel.projectionsByEvent[event.type] ?? []) {
        try {
          await projection.project({
            event,
            table: readModel.ports.table,
            client: readModel.ports.client,
          });
        } catch (error) {
          logger.error("projection failed", {
            readModel: readModel.name,
            projection: projection.key,
            eventId: event.id,
            eventType: event.type,
            ...errorDetails(error),
          });
          throw error;
        }
      }
    }
    return true;
  },
});
