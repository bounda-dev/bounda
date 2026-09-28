import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { createCommandsFacade } from "../command/facade.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import { createReactionCommandIds, deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { withTimeout } from "../shared/timeout.ts";
import { ATTRIBUTES, traced } from "../telemetry.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { afterFrom, type Deadline } from "./deadlines.ts";
import { eventContext, type ProcessInstance } from "./lifecycle.ts";
import { handlerOf } from "./routes.ts";

export interface RunEventHandlerArgs {
  readonly process: ProcessRuntime;
  readonly event: StoredEvent;
  readonly instanceId: string;
  readonly instance: ProcessInstance;
  readonly attempt: number;
  /**
   * Set when a dead letter is replayed, so the handler's `idempotencyKey` differs from the failed
   * run's.
   */
  readonly replay?: string | undefined;
}

export interface RunDeadlineHandlerArgs {
  readonly process: ProcessRuntime;
  readonly instanceId: string;
  readonly instance: ProcessInstance;
  readonly due: Deadline;
  readonly context: CausationContext;
  /**
   * The id the deadline's lifecycle event is written with: what the handler's commands are
   * caused by.
   */
  readonly causationId: string;
  readonly replay?: string | undefined;
}

/**
 * Runs the handlers users write for a process, traced and bounded by the policy timeout, and
 * resolves to the state they leave, parsed with the process `state` schema. A handler that
 * returns nothing leaves the state as it was.
 */
export interface ProcessHandlers {
  runEventHandler(args: RunEventHandlerArgs): Promise<object>;
  /**
   * Runs the handler of `due`, if it has one.
   */
  runDeadlineHandler(args: RunDeadlineHandlerArgs): Promise<object>;
}

export interface CreateProcessHandlersArgs {
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
}

export interface CreateProcessHandlersFunction {
  (args: CreateProcessHandlersArgs): ProcessHandlers;
}

export const createProcessHandlers: CreateProcessHandlersFunction = ({
  aggregates,
  pipeline,
  config,
  clock,
}) => {
  const handlerArgs = (
    process: ProcessRuntime,
    context: CausationContext,
    idempotencyKey: string,
    triggeredAt: string,
  ): Record<string, unknown> => ({
    ...process.collaborators,
    commands: createCommandsFacade({
      aggregates,
      pipeline,
      context,
      commandIds: createReactionCommandIds(idempotencyKey),
    }),
    idempotencyKey,
    after: afterFrom(triggeredAt),
  });

  const timeoutMs = (process: ProcessRuntime): number =>
    config.forAggregate(process.aggregate).policies.timeoutMs;

  const runEventHandler = async ({
    process,
    event,
    instanceId,
    instance,
    attempt,
    replay,
  }: RunEventHandlerArgs): Promise<object> => {
    const next = await traced({
      name: `bounda.process ${process.name}`,
      attributes: {
        [ATTRIBUTES.process]: process.name,
        [ATTRIBUTES.eventId]: event.id,
        [ATTRIBUTES.eventType]: event.type,
        [ATTRIBUTES.aggregateType]: event.aggregateType,
        [ATTRIBUTES.aggregateId]: event.aggregateId,
        [ATTRIBUTES.correlationId]: event.metadata.correlationId,
        [ATTRIBUTES.attempt]: attempt,
      },
      run: () =>
        withTimeout({
          run: () =>
            handlerOf(
              process,
              event,
            )?.({
              ...handlerArgs(
                process,
                eventContext(event),
                deriveIdempotencyKey({
                  kind: "process",
                  handler: process.name,
                  subject: event.id,
                  replay,
                }),
                event.timestamp,
              ),
              event,
              state: instance.state,
              aggregateId: instanceId,
            }),
          timeoutMs: timeoutMs(process),
          subject: `process ${process.name}`,
          clock,
        }),
    });
    return validState(process, next === undefined ? instance.state : next);
  };

  const runDeadlineHandler = async ({
    process,
    instanceId,
    instance,
    due,
    context,
    causationId,
    replay,
  }: RunDeadlineHandlerArgs): Promise<object> => {
    const handler = process.deadlineHandlers[due.field];
    const returned =
      handler === undefined
        ? instance.state
        : await traced({
            name: `bounda.process ${process.name} at ${due.field}`,
            attributes: {
              [ATTRIBUTES.process]: process.name,
              [ATTRIBUTES.aggregateType]: process.aggregate,
              [ATTRIBUTES.aggregateId]: instanceId,
              [ATTRIBUTES.correlationId]: context.correlationId,
            },
            run: () =>
              withTimeout({
                run: () =>
                  handler({
                    ...handlerArgs(
                      process,
                      { correlationId: context.correlationId, causationId, depth: 0 },
                      deriveIdempotencyKey({
                        kind: "process",
                        handler: process.name,
                        subject: `${instanceId}:deadline:${due.field}:${new Date(due.at).toISOString()}`,
                        replay,
                      }),
                      due.at,
                    ),
                    state: instance.state,
                    aggregateId: instanceId,
                  }),
                timeoutMs: timeoutMs(process),
                subject: `process ${process.name} at ${due.field}`,
                clock,
              }),
          });
    return validState(process, returned ?? instance.state);
  };

  return { runEventHandler, runDeadlineHandler };
};

export interface ValidStateFunction {
  (process: Pick<ProcessRuntime, "name" | "stateSchema">, state: unknown): object;
}

/**
 * The state a handler returned, parsed with the process `state` schema when it has one.
 */
export const validState: ValidStateFunction = (process, state) => {
  if (process.stateSchema === null) return state as object;
  const parsed = process.stateSchema.safeParse(state);
  if (parsed.success) return parsed.data as object;
  throw new ValidationError(
    `Process ${process.name} returned a state its schema refuses`,
    parsed.error.issues.map((issue) => ({
      path: issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
      message: issue.message,
    })),
  );
};
