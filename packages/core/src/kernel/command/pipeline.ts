import type { EventStore, PendingEvent } from "../../adapter/ports/event-store.ts";
import type { Scheduler } from "../../adapter/ports/scheduler.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type {
  Command,
  CommandRejection,
  DispatchOptions,
  DispatchResult,
  RejectedDispatch,
  StoredDispatch,
} from "../../contracts/command.ts";
import { parseDuration } from "../../contracts/duration.ts";
import {
  ChainDepthExceededError,
  ConcurrencyError,
  ConfigurationError,
  CreationOrderError,
  DomainError,
  NotFoundError,
  rejectionOf,
  ValidationError,
} from "../../contracts/errors.ts";
import type { NewEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import { foldState } from "../aggregate/fold-state.ts";
import type { AggregateRuntime, AggregatesRuntime, CommandRuntime } from "../aggregate/runtime.ts";
import { errorDetails } from "../shared/retry.ts";
import { withTimeout } from "../shared/timeout.ts";
import { withPorts } from "../shared/with-ports.ts";
import { ATTRIBUTES, METRICS, meter, SPAN_EVENTS, traced } from "../telemetry.ts";
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
   * Aborted when the reaction that dispatches the command is abandoned, so the command stops too.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * A command the runtime dispatches on its own, for a reaction, the scheduler or a replay, where
 * nobody waits for its rejection.
 */
export interface UnattendedDispatchArgs extends DispatchArgs {
  /**
   * The unit of work to load from and write to instead of the storage's own, which holds the
   * command's events and schedule until it commits.
   */
  readonly within: UnitStores;
}

export interface CommandPipeline {
  /**
   * Throws a rejection, as the `DomainError` its handler's `reject` made, to the caller.
   */
  dispatch(args: DispatchArgs): Promise<DispatchResult>;
  /**
   * Resolves with a rejection, logged at once and reported to `onRejection` once `within`
   * commits, so an attempt that is retried reports it only from the run that counts.
   */
  dispatchUnattended(args: UnattendedDispatchArgs): Promise<DispatchResult | RejectedDispatch>;
}

export interface CreateCommandPipelineArgs {
  readonly aggregates: AggregatesRuntime;
  readonly eventStore: EventStore;
  readonly scheduler: Scheduler;
  readonly config: ResolvedConfig;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Told of every rejection of an unattended dispatch whose unit of work commits.
   */
  readonly onRejection?: (rejection: CommandRejection) => void;
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

// The handler has decided by the time it calls `reject`: a `rejections` that throws, or that does
// not declare the code, costs the rejection its message, never the rejection itself.
const declaredMessage = (
  rejections: NonNullable<CommandRuntime["rejections"]>,
  command: Command,
  state: object,
  code: string,
  logger: Logger,
): string => {
  const fields = { type: command.type, rejected: code };
  let message: unknown;
  try {
    // `Object` so a module that returns no object, as plain JS can, finds no message either.
    const messages: Readonly<Record<string, unknown>> = Object(rejections({ command, state }));
    message = Object.hasOwn(messages, code) ? messages[code] : undefined;
  } catch (error) {
    logger.warn("command rejections threw; the rejection takes its code as message", {
      ...fields,
      error: errorDetails(error),
    });
    return code;
  }
  if (typeof message === "string") return message;
  logger.warn(
    "command rejected with a code its rejections do not declare; the code is its message",
    fields,
  );
  return code;
};

// Only a command that declares `rejections` gets `reject`, as its handler's arguments say. What it
// makes goes in `issued`: a DomainError from anywhere else, such as another app's command, is a
// failure of this one, not a rejection it declared.
const rejectOf = (
  runtime: CommandRuntime,
  command: Command,
  state: object,
  issued: WeakSet<DomainError>,
  logger: Logger,
): { readonly reject?: (code: string, message?: string) => DomainError } => {
  const { rejections } = runtime;
  if (rejections === null) return {};
  return {
    reject: (code, message) => {
      const error = new DomainError(
        rejectionOf(code, message ?? declaredMessage(rejections, command, state, code, logger)),
      );
      issued.add(error);
      return error;
    },
  };
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
  onRejection,
}) => {
  // Only streams written before `create` existed land here, so the set stays small.
  const warnedOpenings = new Set<string>();
  const execute = async (
    aggregate: AggregateRuntime,
    runtime: CommandRuntime,
    command: Command,
    store: EventStore,
    signals: readonly AbortSignal[],
  ): Promise<StoredDispatch | DomainError> => {
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
      const issued = new WeakSet<DomainError>();
      const produced = (await withTimeout({
        run: (signal) =>
          runtime.handler(
            withPorts(aggregate.ports, {
              command,
              state,
              events: aggregate.eventBuilders,
              idempotencyKey: command.metadata.commandId,
              signal,
              ...rejectOf(runtime, command, state, issued, logger),
            }),
          ),
        timeoutMs,
        subject: `command ${command.type}`,
        clock,
        signals,
      }).catch((error: unknown) => {
        if (error instanceof DomainError && issued.has(error)) return error;
        throw error;
      })) as readonly NewEvent[] | DomainError | undefined;
      for (const signal of signals) signal.throwIfAborted();
      if (produced instanceof DomainError) {
        if (!issued.has(produced)) throw produced;
        return produced;
      }
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

  const count = (type: string, outcome: "stored" | "scheduled" | "rejected" | "failed"): void => {
    commands.add(1, { [ATTRIBUTES.commandType]: type, [ATTRIBUTES.outcome]: outcome });
  };

  // `rejected` answers a rejection inside the command's span, where its log line belongs.
  const send = async <Rejected>(
    {
      type,
      payload,
      options = {},
      context,
      commandId: scheduledId,
      signal: reactionSignal,
    }: DispatchArgs,
    within: UnitStores | undefined,
    rejected: (error: DomainError, rejection: CommandRejection) => Rejected,
  ): Promise<DispatchResult | Rejected> => {
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
      run: async (span): Promise<DispatchResult | Rejected> => {
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
        let result: StoredDispatch | DomainError;
        try {
          result = await execute(aggregate, runtime, command, stores.eventStore, signals);
        } catch (error) {
          count(type, "failed");
          throw error;
        }
        if (result instanceof DomainError) {
          span.setAttribute(ATTRIBUTES.outcome, "rejected");
          span.addEvent(SPAN_EVENTS.commandRejected, { [ATTRIBUTES.rejected]: result.rejected });
          count(type, "rejected");
          return rejected(result, {
            type,
            rejected: result.rejected,
            message: result.message,
            aggregateType: aggregate.name,
            aggregateId,
          });
        }
        span.setAttributes({
          [ATTRIBUTES.outcome]: "stored",
          [ATTRIBUTES.eventCount]: result.eventIds.length,
        });
        count(type, "stored");
        return result;
      },
    });
  };

  return {
    dispatch: async (args) => {
      const outcome = await send(args, undefined, (error) => error);
      // Thrown outside the span: a rejection is the command's answer, not a failure of it.
      if (outcome instanceof DomainError) throw outcome;
      return outcome;
    },
    dispatchUnattended: ({ within, ...args }) =>
      send(args, within, (_error, rejection) => {
        logger.info("command rejected", { ...rejection });
        within.afterCommit(() => onRejection?.(rejection));
        const { type: _type, ...answer } = rejection;
        return answer;
      }),
  };
};
