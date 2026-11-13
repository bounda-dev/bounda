import type { StoredDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import {
  DeadLetterNotRetriableError,
  DeadLetterSettledError,
  NotFoundError,
} from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import type { AppStorage } from "../events/app-event-store.ts";
import { openCommandPayload } from "../personal-data/commands.ts";
import type { PoliciesRuntime } from "../policy/build-policies.ts";
import type { PolicyExecutor } from "../policy/executor.ts";
import type { ProcessDeadLetters } from "../process/dead-letter-retry.ts";
import { PROCESS_DEADLINE_COMMAND } from "../process/deadlines.ts";
import { startedBy } from "../shared/causation.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { commitWork, type UnitOfWork } from "../unit-of-work/unit-of-work.ts";

/**
 * What `DeadLetters.retry` and the worker's retry of a restricted person's letters share.
 */
export interface DeadLetterRetry {
  /**
   * Runs the failed handler the letter records once more and marks the letter `retried`, as
   * `DeadLetters.retry` describes, for a letter read as `failed`. Rejects as it does, without
   * running anything, when the app cannot retry it, and with the handler's error when it fails
   * again, the letter left `failed`. `actor` is who retries, who acts in what the run writes.
   */
  retry(letter: StoredDeadLetter, actor?: string): Promise<void>;
}

export interface CreateDeadLetterRetryArgs {
  readonly storage: AppStorage;
  readonly pipeline: CommandPipeline;
  readonly aggregates: AggregatesRuntime;
  readonly policies: PoliciesRuntime;
  readonly policyExecutor: PolicyExecutor;
  readonly processes: ProcessDeadLetters;
  readonly config: ResolvedConfig;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface CreateDeadLetterRetryFunction {
  (args: CreateDeadLetterRetryArgs): DeadLetterRetry;
}

/**
 * A retry bypasses the inbox ledger on purpose: the ledger already says the handler ran, and
 * whoever retries is asking for another run.
 */
export const createDeadLetterRetry: CreateDeadLetterRetryFunction = ({
  storage,
  pipeline,
  aggregates,
  policies,
  policyExecutor,
  processes,
  config,
  ids,
  clock,
}) => {
  // The retry's writes and the letter's new status, together or not at all. A retry that
  // another one settled first writes nothing, and does not run again after a conflict.
  const settled = (
    letter: StoredDeadLetter,
    run: (unit: UnitOfWork) => Promise<void>,
  ): Promise<void> =>
    commitWork({
      storage,
      concurrencyRetries: config.runtime.commands.concurrencyRetries,
      work: async (unit) => {
        await run(unit);
        await unit.deadLetterStore.updateStatus(letter.id, "retried", clock.now());
      },
      beforeRerun: async () => {
        const current = await storage.deadLetterStore.get(letter.id);
        if (current?.status !== "failed") throw new DeadLetterSettledError({ id: letter.id });
      },
    });

  const eventOf = async (letter: StoredDeadLetter): Promise<StoredEvent> => {
    const event = await storage.eventStore.readOne({
      aggregateType: letter.aggregateType,
      aggregateId: letter.aggregateId,
      eventId: letter.eventId,
    });
    if (event === null) {
      throw runtimeText(
        new NotFoundError(
          `Event ${letter.eventId} of ${letter.aggregateType}:${letter.aggregateId} not found`,
        ),
      );
    }
    return event;
  };

  const retryPolicy = async (
    letter: StoredDeadLetter,
    retryId: string,
    actor: string | undefined,
  ): Promise<void> => {
    const policy = policies.byName[letter.handler];
    if (policy === undefined) {
      throw runtimeText(
        new DeadLetterNotRetriableError(`Policy "${letter.handler}" is no longer in the registry`),
      );
    }
    const event = await eventOf(letter);
    if (event.aggregateType !== policy.source || !policy.on.includes(event.type)) {
      throw runtimeText(
        new DeadLetterNotRetriableError(
          `Policy "${policy.name}" no longer handles ${event.aggregateType}.${event.type}`,
        ),
      );
    }
    await settled(letter, (unit) =>
      policyExecutor.run({
        policy,
        event,
        attempt: letter.attempts + 1,
        retryId,
        actor,
        within: unit,
      }),
    );
  };

  const retryScheduled = async (
    letter: StoredDeadLetter,
    actor: string | undefined,
  ): Promise<void> => {
    if (aggregates.commandsByType[letter.eventType] === undefined) {
      throw runtimeText(
        new DeadLetterNotRetriableError(
          `Command "${letter.eventType}" is no longer in the registry`,
        ),
      );
    }
    const { payload, forgotten, opened } = await openCommandPayload({
      payload: letter.payload,
      keys: storage.personalKeys,
    });
    if (forgotten) {
      throw runtimeText(
        new DeadLetterNotRetriableError(
          `Command "${letter.eventType}" holds personal data of a person forgotten since`,
        ),
      );
    }
    const context = { ...startedBy(ids.next(), actor), causationId: letter.id };
    await settled(letter, async (unit) => {
      unit.read(letter.persons ?? []);
      await pipeline.dispatchUnattended({
        type: letter.eventType,
        payload,
        opened,
        context,
        within: unit,
      });
    });
  };

  // Resolves to whether the letter still has to be marked retried: a policy, scheduled command
  // or follow-up retry marks it in its own unit; any other process retry leaves it for after the
  // drain.
  const run = async (
    letter: StoredDeadLetter,
    retryId: string,
    actor: string | undefined,
  ): Promise<boolean> => {
    switch (letter.kind) {
      case "policy":
        await retryPolicy(letter, retryId, actor);
        return false;
      case "process":
        if (letter.eventType === PROCESS_DEADLINE_COMMAND) {
          await processes.retryDeadline({
            payload: { process: letter.handler, aggregateId: letter.aggregateId },
            context: { ...startedBy(ids.next(), actor), causationId: letter.id },
            retryId,
            letter: letter.id,
          });
          return true;
        }
        return !(await processes.retry({
          process: letter.handler,
          event: await eventOf(letter),
          retryId,
          letter: letter.id,
          actor,
        }));
      case "scheduled":
        await retryScheduled(letter, actor);
        return false;
      default:
        // Stores cast the stored kind, so a row no release writes still reaches here.
        throw runtimeText(
          new DeadLetterNotRetriableError(
            `Dead letter "${letter.id}" has an unknown kind "${String(letter.kind satisfies never)}"`,
          ),
        );
    }
  };

  return {
    retry: async (letter, actor) => {
      if (await run(letter, ids.next(), actor)) {
        await storage.deadLetterStore.updateStatus(letter.id, "retried", clock.now());
      }
    },
  };
};
