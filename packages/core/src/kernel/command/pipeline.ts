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
  CreationOrderError,
  NotFoundError,
  ValidationError,
} from "../../contracts/errors.ts";
import type { NewEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import { foldState } from "../aggregate/fold-state.ts";
import type { AggregateRuntime, AggregatesRuntime, CommandRuntime } from "../aggregate/runtime.ts";
import { withTimeout } from "../shared/timeout.ts";
import { withCollaborators } from "../shared/with-collaborators.ts";
import { ATTRIBUTES, METRICS, meter, traced } from "../telemetry.ts";
import type { UnitStores } from "../unit-of-work/unit-of-work.ts";
import { validatePayload } from "./validate.ts";

export interface DispatchArgs {
  readonly type: string;
  readonly payload: unknown;
  readonly options?: DispatchOptions;
  readonly context?: CausationContext;
  /**
   * Used instead of a new id: the one a scheduled command was given when scheduled, kept across the
   * worker's retries, or the one a reaction derives, so a retried reaction dispatches the same
   * command.
   */
  readonly commandId?: string | undefined;
  /**
   * The stores to load from and write to instead of the storage's own: a reaction's unit of work,
   * which holds the command's events and schedule until the attempt commits.
   */
  readonly within?: UnitStores | undefined;
  /**
   * Aborted when the reaction that dispatches the command is abandoned, so the command stops too.
   */
  readonly signal?: AbortSignal | undefined;
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

const SCHEDULED_COMMAND_PREFIX = "command:";

export interface ScheduledCommandKeyFunction {
  (commandId: string): string;
}

/**
 * The scheduler's dedupe key for a delayed command.
 */
export const scheduledCommandKey: ScheduledCommandKeyFunction = (commandId) =>
  `${SCHEDULED_COMMAND_PREFIX}${commandId}`;

export interface ScheduledCommandIdFunction {
  (dedupeKey: string): string | undefined;
}

/**
 * The id a delayed command was scheduled with; `undefined` for a key that is not a command's.
 */
export const scheduledCommandId: ScheduledCommandIdFunction = (dedupeKey) =>
  dedupeKey.startsWith(SCHEDULED_COMMAND_PREFIX)
    ? dedupeKey.slice(SCHEDULED_COMMAND_PREFIX.length)
    : undefined;

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

const asStored = (payload: unknown): unknown =>
  payload === undefined ? payload : JSON.parse(JSON.stringify(payload));

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

// What makes the state types true: `apply` only ever runs on an aggregate `create` opened.
const checkCreationOrder = (
  aggregate: AggregateRuntime,
  command: Command,
  created: boolean,
  events: readonly PendingEvent[],
): void => {
  if (!aggregate.opensWithCreate) return;
  let exists = created;
  for (const event of events) {
    const runtime = aggregate.eventsByType[event.type];
    if (!exists && runtime?.create === null) {
      throw new CreationOrderError(
        `Command "${command.type}" returned "${event.type}" for ${aggregate.name} ${command.aggregateId}, which does not exist yet: it must start with an event that exports create`,
      );
    }
    if (exists && runtime?.apply === null) {
      throw new CreationOrderError(
        `Command "${command.type}" returned "${event.type}" for ${aggregate.name} ${command.aggregateId}, which exists already: "${event.type}" only exports create`,
      );
    }
    exists = true;
  }
};

/**
 * Commands with `delay` are scheduled with the payload as the caller passed it, in the JSON form
 * every scheduler stores. Validating that form here only rejects early what would fail when the
 * command runs, such as a date JSON turns into a string; the validation whose result the handler
 * sees happens then, so a transform does not apply twice.
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
  // Only streams written before `create` existed land here, so the set stays small.
  const warnedOpenings = new Set<string>();
  const execute = async (
    aggregate: AggregateRuntime,
    runtime: CommandRuntime,
    command: Command,
    store: EventStore,
    signals: readonly AbortSignal[],
  ): Promise<DispatchResult> => {
    const attempts = config.runtime.commands.concurrencyRetries + 1;
    const { timeoutMs } = config.forAggregate(aggregate.name).commands;
    for (let attempt = 1; ; attempt += 1) {
      const loaded = await store.load({
        aggregateType: aggregate.name,
        aggregateId: command.aggregateId,
      });
      const folded = foldState({ aggregate, events: loaded.events });
      const stream = `${aggregate.name}:${command.aggregateId}`;
      if (folded.openedWithout !== null && !warnedOpenings.has(stream)) {
        warnedOpenings.add(stream);
        logger.warn("aggregate opened by an event without create; its state may lack fields", {
          aggregateType: aggregate.name,
          aggregateId: command.aggregateId,
          eventType: folded.openedWithout,
        });
      }
      const state = { ...folded.state, id: command.aggregateId, version: loaded.version };
      const produced = (await withTimeout({
        run: (signal) =>
          runtime.handler(
            withCollaborators(aggregate.collaborators, {
              command,
              state,
              events: aggregate.eventBuilders,
              idempotencyKey: command.metadata.commandId,
              signal,
            }),
          ),
        timeoutMs,
        subject: `command ${command.type}`,
        clock,
        signals,
      })) as readonly NewEvent[] | undefined;
      for (const signal of signals) signal.throwIfAborted();
      const events = toPendingEvents(
        aggregate,
        command,
        produced ?? [],
        loaded.version,
        ids,
        clock.now().toISOString(),
      );
      checkCreationOrder(aggregate, command, folded.created, events);
      if (events.length === 0) {
        return {
          scheduled: false,
          aggregateType: aggregate.name,
          aggregateId: command.aggregateId,
          version: loaded.version,
          eventIds: [],
          eventTypes: [],
          position: 0,
        };
      }
      try {
        const appended = await store.append({
          aggregateType: aggregate.name,
          aggregateId: command.aggregateId,
          expectedVersion: loaded.version,
          events,
        });
        return {
          scheduled: false,
          aggregateType: aggregate.name,
          aggregateId: command.aggregateId,
          version: appended.version,
          eventIds: appended.events.map((event) => event.id),
          eventTypes: appended.events.map((event) => event.type),
          position: appended.events.at(-1)?.position ?? 0,
        };
      } catch (error) {
        if (!(error instanceof ConcurrencyError) || attempt >= attempts) throw error;
        logger.debug("command retried after concurrency conflict", { type: command.type, attempt });
      }
    }
  };

  const commands = meter().createCounter(METRICS.commands, {
    description: "Commands dispatched, by type and outcome",
    unit: "{command}",
  });

  const count = (type: string, outcome: "stored" | "scheduled" | "rejected"): void => {
    commands.add(1, { [ATTRIBUTES.commandType]: type, [ATTRIBUTES.outcome]: outcome });
  };

  const dispatch = async ({
    type,
    payload,
    options = {},
    context,
    commandId: scheduledId,
    within,
    signal: reactionSignal,
  }: DispatchArgs): Promise<DispatchResult> => {
    const stores = within ?? { eventStore, scheduler };
    const entry = aggregates.commandsByType[type];
    if (entry === undefined) throw new NotFoundError(`Unknown command "${type}"`);
    const { aggregate, command: runtime } = entry;
    const depth = context?.depth ?? 0;
    const maxDepth = config.forAggregate(aggregate.name).policies.maxChainDepth;
    if (depth > maxDepth) throw new ChainDepthExceededError(depth, maxDepth);

    const delayed = options.delay !== undefined;
    const input = delayed ? asStored(payload) : payload;
    const parsed = validatePayload({
      schema: runtime.schema,
      payload: input,
      subject: delayed ? `delayed command ${type}` : `command ${type}`,
    });
    const aggregateId = resolveAggregateId(aggregate, parsed);
    const commandId = scheduledId ?? ids.next();
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

    const signals = [reactionSignal, options.signal].filter((one) => one !== undefined);
    for (const signal of signals) signal.throwIfAborted();

    return traced({
      name: `bounda.command ${type}`,
      attributes: {
        [ATTRIBUTES.commandType]: type,
        [ATTRIBUTES.aggregateType]: aggregate.name,
        [ATTRIBUTES.aggregateId]: aggregateId,
        [ATTRIBUTES.correlationId]: command.metadata.correlationId,
        [ATTRIBUTES.causationId]: command.metadata.causationId,
      },
      run: async (span) => {
        if (options.delay !== undefined) {
          const executeAt = new Date(clock.now().getTime() + parseDuration(options.delay));
          await stores.scheduler.schedule({
            dedupeKey: scheduledCommandKey(commandId),
            command: { type, payload: input, aggregateId },
            executeAt,
            context: {
              correlationId: command.metadata.correlationId,
              causationId: command.metadata.causationId,
              depth,
            },
          });
          span.setAttribute(ATTRIBUTES.outcome, "scheduled");
          count(type, "scheduled");
          return {
            scheduled: true,
            aggregateType: aggregate.name,
            aggregateId,
            executeAt: executeAt.toISOString(),
          };
        }
        try {
          const result = await execute(aggregate, runtime, command, stores.eventStore, signals);
          span.setAttributes({
            [ATTRIBUTES.outcome]: "stored",
            [ATTRIBUTES.eventCount]: result.scheduled ? 0 : result.eventIds.length,
          });
          count(type, "stored");
          return result;
        } catch (error) {
          count(type, "rejected");
          throw error;
        }
      },
    });
  };

  return { dispatch };
};
