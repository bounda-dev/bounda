import type { EventStore, PendingEvent } from "../../adapter/ports/event-store.ts";
import type { Scheduler } from "../../adapter/ports/scheduler.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Command, DispatchOptions, DispatchResult } from "../../contracts/command.ts";
import { parseDuration } from "../../contracts/duration.ts";
import {
  ChainDepthExceededError,
  ConcurrencyError,
  ConfigurationError,
  NotFoundError,
  ValidationError,
} from "../../contracts/errors.ts";
import type { NewEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import { foldState } from "../aggregate/fold-state.ts";
import type { AggregateRuntime, AggregatesRuntime, CommandRuntime } from "../aggregate/runtime.ts";
import { validatePayload } from "./validate.ts";

export interface DispatchArgs {
  readonly type: string;
  readonly payload: unknown;
  readonly options?: DispatchOptions;
  readonly context?: CausationContext;
}

export interface CommandPipeline {
  dispatch(args: DispatchArgs): Promise<DispatchResult>;
}

export interface CreateCommandPipelineArgs {
  readonly aggregates: AggregatesRuntime;
  readonly eventStore: EventStore;
  readonly scheduler: Scheduler;
  readonly config: ResolvedConfig;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateCommandPipelineFunction {
  (args: CreateCommandPipelineArgs): CommandPipeline;
}

const resolveAggregateId = (aggregate: AggregateRuntime, payload: unknown): string => {
  const record = payload as Record<string, unknown>;
  const value = record[aggregate.aggregateIdField] ?? record.id;
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`Command for "${aggregate.name}" has no aggregate id`, [
      { path: [aggregate.aggregateIdField], message: "Expected a non-empty string" },
    ]);
  }
  return value;
};

const toPendingEvents = (
  aggregate: AggregateRuntime,
  command: Command,
  produced: readonly NewEvent[],
  baseVersion: number,
  ids: IdGenerator,
  timestamp: string,
): PendingEvent[] =>
  produced.map((event, index) => {
    const runtime = aggregate.eventsByType[event.type];
    if (runtime === undefined) {
      throw new ConfigurationError(
        `Command "${command.type}" returned event "${event.type}", which "${aggregate.name}" does not define`,
      );
    }
    return {
      id: ids.next(),
      aggregateType: aggregate.name,
      aggregateId: command.aggregateId,
      version: baseVersion + index + 1,
      type: event.type,
      payload: validatePayload({
        schema: runtime.schema,
        payload: event.payload,
        subject: `event ${event.type}`,
      }),
      timestamp,
      metadata: {
        correlationId: command.metadata.correlationId,
        causationId: command.metadata.commandId,
        depth: command.metadata.depth,
        schemaVersion: runtime.schemaVersion,
        system: false,
      },
    };
  });

/**
 * The write path. `dispatch` validates the payload, loads the aggregate, runs the handler with its
 * events and collaborators, and appends with the version it loaded. A `ConcurrencyError` from the
 * store reloads and retries up to `runtime.commands.concurrencyRetries` times; a `DomainError`
 * from the handler is returned to the caller untouched. Commands with `delay` go to the scheduler.
 */
export const createCommandPipeline: CreateCommandPipelineFunction = ({
  aggregates,
  eventStore,
  scheduler,
  config,
  ids,
  clock,
  logger,
}) => {
  const execute = async (
    aggregate: AggregateRuntime,
    runtime: CommandRuntime,
    command: Command,
  ): Promise<DispatchResult> => {
    const attempts = config.runtime.commands.concurrencyRetries + 1;
    for (let attempt = 1; ; attempt += 1) {
      const loaded = await eventStore.load({
        aggregateType: aggregate.name,
        aggregateId: command.aggregateId,
      });
      const state = {
        ...foldState({ aggregate, events: loaded.events }),
        id: command.aggregateId,
        version: loaded.version,
      };
      const produced = (await runtime.handler({
        ...runtime.collaborators,
        command,
        state,
        events: aggregate.eventBuilders,
      })) as readonly NewEvent[] | undefined;
      const events = toPendingEvents(
        aggregate,
        command,
        produced ?? [],
        loaded.version,
        ids,
        clock.now().toISOString(),
      );
      if (events.length === 0) {
        return {
          scheduled: false,
          aggregateId: command.aggregateId,
          version: loaded.version,
          eventIds: [],
        };
      }
      try {
        const appended = await eventStore.append({
          aggregateType: aggregate.name,
          aggregateId: command.aggregateId,
          expectedVersion: loaded.version,
          events,
        });
        return {
          scheduled: false,
          aggregateId: command.aggregateId,
          version: appended.version,
          eventIds: appended.events.map((event) => event.id),
        };
      } catch (error) {
        if (!(error instanceof ConcurrencyError) || attempt >= attempts) throw error;
        logger.debug("command retried after concurrency conflict", { type: command.type, attempt });
      }
    }
  };

  return {
    dispatch: async ({ type, payload, options = {}, context }) => {
      const entry = aggregates.commandsByType[type];
      if (entry === undefined) throw new NotFoundError(`Unknown command "${type}"`);
      const { aggregate, command: runtime } = entry;
      const depth = context?.depth ?? 0;
      const maxDepth = config.forAggregate(aggregate.name).policies.maxChainDepth;
      if (depth > maxDepth) throw new ChainDepthExceededError(depth, maxDepth);

      const parsed = validatePayload({
        schema: runtime.schema,
        payload,
        subject: `command ${type}`,
      });
      const aggregateId = resolveAggregateId(aggregate, parsed);
      const commandId = ids.next();
      const command: Command = {
        type,
        payload: parsed,
        aggregateId,
        metadata: {
          commandId,
          correlationId: options.correlationId ?? context?.correlationId ?? commandId,
          causationId: context?.causationId ?? commandId,
          depth,
          timestamp: clock.now().toISOString(),
        },
      };

      if (options.delay !== undefined) {
        const executeAt = new Date(clock.now().getTime() + parseDuration(options.delay));
        await scheduler.schedule({
          dedupeKey: `command:${commandId}`,
          command: { type, payload: parsed, aggregateId },
          executeAt,
          context: {
            correlationId: command.metadata.correlationId,
            causationId: command.metadata.causationId,
            depth,
          },
        });
        return { scheduled: true, aggregateId, executeAt: executeAt.toISOString() };
      }

      return execute(aggregate, runtime, command);
    },
  };
};
