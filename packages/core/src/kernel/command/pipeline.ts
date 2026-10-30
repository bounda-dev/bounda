import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type { AppendResult, EventStore, PendingEvent } from "../../adapter/storage/event-store.ts";
import type {
  DispatchOutcome,
  PutIdempotencyRecordArgs,
} from "../../adapter/storage/idempotency-store.ts";
import type { Scheduler } from "../../adapter/storage/scheduler.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import {
  type Command,
  type CommandRejection,
  type DispatchOptions,
  type DispatchResult,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  type RejectedDispatch,
  type ScheduledDispatch,
  type StoredDispatch,
} from "../../contracts/command.ts";
import { type DurationInput, parseDuration } from "../../contracts/duration.ts";
import {
  BoundaError,
  ChainDepthExceededError,
  ConcurrencyError,
  ConfigurationError,
  CreationOrderError,
  DomainError,
  IdempotencyKeyConflictError,
  IdempotencyKeyTakenError,
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
import { fingerprintOf } from "./fingerprint.ts";
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
 * A command the runtime dispatches on its own, for a reaction, the scheduler or a dead-letter
 * retry, where nobody waits for its rejection.
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
  readonly storage: Storage;
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
 * The scheduler's dedupe key for a scheduled command.
 */
export const scheduledCommandKey: ScheduledCommandKeyFunction = (commandId) =>
  `${SCHEDULED_COMMAND_PREFIX}${commandId}`;

export interface ScheduledCommandIdFunction {
  (dedupeKey: string): string | undefined;
}

/**
 * The id a scheduled command was scheduled with; `undefined` for a key that is not a command's.
 */
export const scheduledCommandId: ScheduledCommandIdFunction = (dedupeKey) =>
  dedupeKey.startsWith(SCHEDULED_COMMAND_PREFIX)
    ? dedupeKey.slice(SCHEDULED_COMMAND_PREFIX.length)
    : undefined;

type DispatchStores = Pick<StorageTransaction, "eventStore" | "scheduler" | "idempotencyStore">;

interface Idempotency {
  readonly key: string;
  readonly fingerprint: string;
}

const checkIdempotencyKey = (type: string, key: unknown): string => {
  if (typeof key === "string" && key.length > 0 && key.length <= MAX_IDEMPOTENCY_KEY_LENGTH) {
    return key;
  }
  throw new ValidationError(`Command "${type}" has an invalid idempotency key`, [
    {
      path: ["idempotencyKey"],
      message: `Expected a string of 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    },
  ]);
};

const storedDispatch = (
  aggregate: AggregateRuntime,
  aggregateId: string,
  appended: AppendResult,
): StoredDispatch => ({
  scheduled: false,
  aggregateType: aggregate.name,
  aggregateId,
  version: appended.version,
  eventIds: appended.events.map((event) => event.id),
  eventTypes: appended.events.map((event) => event.type),
  position: appended.events.at(-1)?.position ?? 0,
});

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
        causationId: command.metadata.causationId,
        commandId: command.metadata.commandId,
        depth: command.metadata.depth,
        schemaVersion: runtime.schemaVersion,
        system: false,
      },
    };
  });

// What makes the state types true: `evolve` only ever runs on an aggregate `begin` opened.
const checkCreationOrder = (
  aggregate: AggregateRuntime,
  command: Command,
  created: boolean,
  events: readonly PendingEvent[],
): void => {
  if (!aggregate.opensWithBegin) return;
  let exists = created;
  for (const event of events) {
    const runtime = aggregate.eventsByType[event.type];
    if (!exists && runtime?.begin === null) {
      throw new CreationOrderError(
        `Command "${command.type}" returned "${event.type}" for ${aggregate.name} ${command.aggregateId}, which does not exist yet: it must start with an event that exports begin`,
      );
    }
    if (exists && runtime?.evolve === null) {
      throw new CreationOrderError(
        `Command "${command.type}" returned "${event.type}" for ${aggregate.name} ${command.aggregateId}, which exists already: "${event.type}" only exports begin`,
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

// A DomainError the handler did not make with `reject` is wrapped, so a caller of `app.commands`
// never takes another command's rejection for this one's. Terminal, as the DomainError it wraps.
class ForeignRejectionError extends BoundaError {
  constructor(command: Command, rejection: DomainError) {
    super(
      "FOREIGN_REJECTION",
      `Command ${command.type} failed on rejection ${rejection.rejected}, which its handler did not make with reject: ${rejection.message}`,
      { cause: rejection },
    );
  }
}

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
  storage,
  config,
  ids,
  clock,
  logger,
  onRejection,
}) => {
  // Only streams written before `begin` existed land here, so the set stays small.
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
        logger.warn("aggregate opened by an event without begin; its state may lack fields", {
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
        if (error instanceof DomainError) return error;
        throw error;
      })) as readonly NewEvent[] | DomainError | undefined;
      for (const signal of signals) signal.throwIfAborted();
      if (produced instanceof DomainError) {
        if (!issued.has(produced)) throw new ForeignRejectionError(command, produced);
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
        return storedDispatch(aggregate, command.aggregateId, {
          version: loaded.version,
          events: [],
        });
      }
      try {
        const appended = await store.append({
          aggregateType: aggregate.name,
          aggregateId: command.aggregateId,
          expectedVersion: loaded.version,
          events,
        });
        return storedDispatch(aggregate, command.aggregateId, appended);
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

  const count = (
    type: string,
    outcome: "stored" | "scheduled" | "rejected" | "replayed" | "failed",
  ): void => {
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
    const stores: DispatchStores = within ?? storage;
    const entry = aggregates.commandsByType[type];
    if (entry === undefined) throw new NotFoundError(`Unknown command "${type}"`);
    const { aggregate, command: runtime } = entry;
    const depth = context?.depth ?? 0;
    const maxDepth = config.forAggregate(aggregate.name).policies.maxChainDepth;
    if (depth > maxDepth) throw new ChainDepthExceededError(depth, maxDepth);
    const idempotency: Idempotency | undefined =
      options.idempotencyKey === undefined
        ? undefined
        : {
            key: checkIdempotencyKey(type, options.idempotencyKey),
            fingerprint: await fingerprintOf({ type, payload }),
          };

    const scheduled = options.delay !== undefined;
    const input = scheduled ? asStored(payload) : payload;
    const parsed = validatePayload({
      schema: runtime.schema,
      payload: input,
      subject: scheduled ? `scheduled command ${type}` : `command ${type}`,
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

    const schedule = async (
      scheduler: Scheduler,
      delay: DurationInput,
    ): Promise<ScheduledDispatch> => {
      const executeAt = new Date(clock.now().getTime() + parseDuration(delay));
      await scheduler.schedule({
        dedupeKey: scheduledCommandKey(commandId),
        command: { type, payload: input, aggregateId },
        executeAt,
        context: {
          correlationId: command.metadata.correlationId,
          causationId: command.metadata.causationId,
          depth,
        },
      });
      return {
        scheduled: true,
        aggregateType: aggregate.name,
        aggregateId,
        executeAt: executeAt.toISOString(),
      };
    };

    const recordOf = (
      { key, fingerprint }: Idempotency,
      outcome: DispatchOutcome,
    ): PutIdempotencyRecordArgs => {
      const now = clock.now();
      return {
        key,
        fingerprint,
        outcome,
        expiresAt: new Date(
          now.getTime() + config.runtime.commands.idempotencyKeyLifetimeMs,
        ).toISOString(),
        now,
      };
    };

    const outcomeOf = (answer: DispatchResult | DomainError): DispatchOutcome =>
      answer instanceof DomainError
        ? {
            rejected: answer.rejected,
            message: answer.message,
            aggregateType: aggregate.name,
            aggregateId,
          }
        : answer;

    // With a key, what the command answers is recorded under it where its events go: in the unit
    // of work, or in the transaction of the append that stores them, so a duplicate running
    // beside it loses on the key and stores nothing.
    const perform = async (): Promise<DispatchResult | DomainError> => {
      if (idempotency === undefined) {
        return options.delay === undefined
          ? execute(aggregate, runtime, command, stores.eventStore, signals)
          : schedule(stores.scheduler, options.delay);
      }
      if (options.delay !== undefined) {
        const delay = options.delay;
        const scheduling = async (transaction: DispatchStores): Promise<ScheduledDispatch> => {
          const answer = await schedule(transaction.scheduler, delay);
          await transaction.idempotencyStore.put(recordOf(idempotency, answer));
          return answer;
        };
        return within === undefined ? storage.transact(scheduling) : scheduling(within);
      }
      if (within !== undefined) {
        const answer = await execute(aggregate, runtime, command, within.eventStore, signals);
        await within.idempotencyStore.put(recordOf(idempotency, outcomeOf(answer)));
        return answer;
      }
      let recorded = false;
      const recording: EventStore = {
        ...storage.eventStore,
        append: async (args) => {
          const appended = await storage.transact(async (transaction) => {
            const result = await transaction.eventStore.append(args);
            await transaction.idempotencyStore.put(
              recordOf(idempotency, storedDispatch(aggregate, aggregateId, result)),
            );
            return result;
          });
          recorded = true;
          return appended;
        },
      };
      const answer = await execute(aggregate, runtime, command, recording, signals);
      if (!recorded) await storage.idempotencyStore.put(recordOf(idempotency, outcomeOf(answer)));
      return answer;
    };

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
        const replay = async (): Promise<DispatchResult | Rejected | null> => {
          if (idempotency === undefined) return null;
          const found = await stores.idempotencyStore.get({
            key: idempotency.key,
            now: clock.now(),
          });
          if (found === null) return null;
          if (found.fingerprint !== idempotency.fingerprint) {
            throw new IdempotencyKeyConflictError({
              idempotencyKey: idempotency.key,
              commandType: type,
            });
          }
          span.setAttribute(ATTRIBUTES.outcome, "replayed");
          count(type, "replayed");
          const { outcome } = found;
          if (!("rejected" in outcome)) return outcome;
          span.addEvent(SPAN_EVENTS.commandRejected, { [ATTRIBUTES.rejected]: outcome.rejected });
          return rejected(new DomainError(rejectionOf(outcome.rejected, outcome.message)), {
            type,
            ...outcome,
          });
        };
        const remembered = await replay();
        if (remembered !== null) return remembered;
        let answer: DispatchResult | DomainError;
        try {
          answer = await perform();
        } catch (error) {
          if (error instanceof IdempotencyKeyTakenError) {
            const taken = await replay();
            if (taken !== null) return taken;
          }
          count(type, "failed");
          throw error;
        }
        if (answer instanceof DomainError) {
          span.setAttribute(ATTRIBUTES.outcome, "rejected");
          span.addEvent(SPAN_EVENTS.commandRejected, { [ATTRIBUTES.rejected]: answer.rejected });
          count(type, "rejected");
          return rejected(answer, {
            type,
            rejected: answer.rejected,
            message: answer.message,
            aggregateType: aggregate.name,
            aggregateId,
          });
        }
        if (answer.scheduled) {
          span.setAttribute(ATTRIBUTES.outcome, "scheduled");
          count(type, "scheduled");
          return answer;
        }
        span.setAttributes({
          [ATTRIBUTES.outcome]: "stored",
          [ATTRIBUTES.eventCount]: answer.eventIds.length,
        });
        count(type, "stored");
        return answer;
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
