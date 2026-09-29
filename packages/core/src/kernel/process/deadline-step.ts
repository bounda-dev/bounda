import { ValidationError } from "../../contracts/errors.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { type Deadline, TIMEOUT_DEADLINE } from "./deadlines.ts";
import type { ProcessHandlers } from "./handlers.ts";
import type { ProcessInstances } from "./instances.ts";
import { lifecycleEntries, type ProcessInstance } from "./lifecycle.ts";

export interface RunDeadlineArgs {
  readonly process: ProcessRuntime;
  readonly instanceId: string;
  readonly instance: ProcessInstance;
  readonly due: Deadline;
  readonly context: CausationContext;
  readonly replay?: string | undefined;
}

/**
 * Reaching one deadline of an instance: its handler runs and `ProcessDeadlineReached` is written
 * with the state it leaves, or `ProcessTimedOut` for the timeout, past any event parked meanwhile.
 */
export interface DeadlineStep {
  run(args: RunDeadlineArgs): Promise<void>;
  /**
   * Runs the step as `run` does, and remembers the deadline an error it throws came from, for
   * `thrownBy`.
   */
  attempt(args: RunDeadlineArgs): Promise<void>;
  /**
   * The deadline whose `attempt` threw `error`; `undefined` for an error thrown anywhere else.
   */
  thrownBy(error: unknown): Deadline | undefined;
}

export interface CreateDeadlineStepArgs {
  readonly instances: ProcessInstances;
  readonly handlers: ProcessHandlers;
  readonly ids: IdGenerator;
}

export interface CreateDeadlineStepFunction {
  (args: CreateDeadlineStepArgs): DeadlineStep;
}

export const createDeadlineStep: CreateDeadlineStepFunction = ({ instances, handlers, ids }) => {
  const run = async ({
    process,
    instanceId,
    instance,
    due,
    context,
    replay,
  }: RunDeadlineArgs): Promise<void> => {
    const reachedId = ids.next();
    const handled = await handlers.runDeadlineHandler({
      process,
      instanceId,
      instance,
      due,
      context,
      causationId: reachedId,
      replay,
    });
    const { state } = handled;
    await handled.record(async () => {
      if (due.field === TIMEOUT_DEADLINE) {
        await instances.appendPastParks(process, instanceId, instance, [
          lifecycleEntries.timedOut(state, context, reachedId),
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
      await instances.appendPastParks(process, instanceId, instance, [
        lifecycleEntries.deadlineReached(due, state, context, reachedId),
      ]);
    });
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
