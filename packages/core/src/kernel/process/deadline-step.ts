import type { ReactionDispatchResult } from "../../contracts/command.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { type Deadline, TIMEOUT_DEADLINE } from "./deadlines.ts";
import type { ProcessHandlers } from "./handlers.ts";
import { lifecycleEntries, type ProcessInstance } from "./lifecycle.ts";
import { handlerOf, startsOn } from "./routes.ts";
import type { ProcessUnits } from "./units.ts";

export interface RunDeadlineArgs {
  readonly unit: UnitOfWork;
  readonly process: ProcessRuntime;
  readonly instanceId: string;
  /**
   * The instance as `unit` sees it.
   */
  readonly instance: ProcessInstance;
  readonly due: Deadline;
  readonly context: CausationContext;
  readonly retryId?: string | undefined;
}

/**
 * Runs the handler of a deadline and stages `ProcessDeadlineReached`, or `ProcessTimedOut` for
 * the timeout with the follow-ups its commands caused, on the unit.
 */
export interface DeadlineStep {
  run(args: RunDeadlineArgs): Promise<void>;
  /**
   * `run`, remembering for `thrownBy` which deadline an error it throws came from.
   */
  attempt(args: RunDeadlineArgs): Promise<void>;
  /**
   * The deadline whose `attempt` threw `error`; `undefined` for an error thrown anywhere else.
   */
  thrownBy(error: unknown): Deadline | undefined;
}

export interface CreateDeadlineStepArgs {
  readonly units: ProcessUnits;
  readonly handlers: ProcessHandlers;
  readonly ids: IdGenerator;
}

export interface CreateDeadlineStepFunction {
  (args: CreateDeadlineStepArgs): DeadlineStep;
}

// The events the timeout's commands decided that a handler of the process takes, read from the
// results so nothing is loaded; a rejected or scheduled command decided none. They are not routed:
// delivery only lets through the follow-ups of the instance an event is routed to, so the user's
// `correlate` never runs here. A starting event is left out, since its handler would start again
// what has ended.
const followUpsOf = (
  process: ProcessRuntime,
  decided: readonly ReactionDispatchResult[],
): readonly string[] =>
  decided.flatMap((result) =>
    result.rejected !== false || result.scheduled
      ? []
      : result.eventIds.filter((_, index) => {
          const event = {
            aggregateType: result.aggregateType,
            type: result.eventTypes[index] ?? "",
          };
          return handlerOf(process, event) !== undefined && !startsOn(process, event);
        }),
  );

export const createDeadlineStep: CreateDeadlineStepFunction = ({ units, handlers, ids }) => {
  const run = async ({
    unit,
    process,
    instanceId,
    instance,
    due,
    context,
    retryId,
  }: RunDeadlineArgs): Promise<void> => {
    const within = units.over(unit);
    const reachedId = ids.next();
    const { state, decided } = await handlers.runDeadlineHandler({
      process,
      instanceId,
      instance,
      due,
      context,
      causationId: reachedId,
      retryId,
      within: unit,
    });
    if (due.field === TIMEOUT_DEADLINE) {
      await within.append(process, instanceId, instance, [
        lifecycleEntries.timedOut(state, context, reachedId, followUpsOf(process, decided)),
      ]);
      return;
    }
    const kept = (state as Readonly<Record<string, unknown>>)[due.field];
    if (
      process.deadlineHandlers[due.field] !== undefined &&
      Date.parse(String(kept)) === Date.parse(due.at)
    ) {
      throw new ValidationError(
        `Process ${process.name} left the deadline "${due.field}" at the moment that came due`,
        [{ path: [due.field], message: "Set it to null, or to another moment with after()" }],
      );
    }
    await within.append(process, instanceId, instance, [
      lifecycleEntries.deadlineReached(due, state, context, reachedId),
    ]);
  };

  const thrown = new WeakMap<object, Deadline>();

  const attempt = async (args: RunDeadlineArgs): Promise<void> => {
    try {
      await run(args);
    } catch (error) {
      const tracked =
        typeof error === "object" && error !== null ? error : new Error(String(error));
      thrown.set(tracked, args.due);
      throw tracked;
    }
  };

  const thrownBy = (error: unknown): Deadline | undefined =>
    typeof error === "object" && error !== null ? thrown.get(error) : undefined;

  return { run, attempt, thrownBy };
};
