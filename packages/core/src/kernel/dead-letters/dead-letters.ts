import type { Storage } from "../../adapter/adapter.ts";
import type { DeadLetter, ListDeadLettersArgs } from "../../adapter/storage/dead-letter-store.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import {
  DeadLetterNotRetriableError,
  DeadLetterSettledError,
  NotFoundError,
} from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import type { PoliciesRuntime } from "../policy/build-policies.ts";
import type { PolicyExecutor } from "../policy/executor.ts";
import type { ProcessDeadLetters } from "../process/dead-letter-retry.ts";
import { PROCESS_DEADLINE_COMMAND } from "../process/deadlines.ts";
import { commitWork, type UnitOfWork } from "../unit-of-work/unit-of-work.ts";

/**
 * What an operator can do with the handler runs that gave up. Retrying or discarding a letter
 * leaves its row in place as a record.
 */
export interface DeadLetters {
  /**
   * The letters of the store, process ones with how many events are `parked` behind them.
   */
  list(args?: ListDeadLettersArgs): Promise<readonly DeadLetter[]>;
  count(args?: ListDeadLettersArgs): Promise<number>;
  /**
   * One letter of the store, a process one with how many events are `parked` behind it.
   */
  get(id: string): Promise<DeadLetter | null>;
  /**
   * Runs the failed handler once more: the policy or process handler for the stored event, the
   * process deadline that failed, or the dropped scheduled command with its recorded payload, and
   * marks the letter `retried`: a policy's, a scheduled command's or that of a process event that
   * follows its instance's timeout in the same transaction as what the run writes, any other
   * process's once its instance has drained what was parked, since a retry cut short there is
   * taken up again by retrying the same letter. A scheduled command its aggregate now rejects
   * counts as retried, as the scheduler would have settled it. Rejects with the handler's error
   * when it fails again, and the letter stays `failed`. Rejects without running anything with
   * `NotFoundError` when the letter, or the event or process instance it names, is missing, and
   * with `DeadLetterNotRetriableError` when the app as it now is cannot retry it. Rejects with
   * `DeadLetterSettledError` a letter that is no longer `failed`, or that another retry or a
   * discard settled while this one ran: a retry marked in its own transaction then writes
   * nothing, any other process's has already handled its events.
   */
  retry(id: string): Promise<DeadLetter>;
  /**
   * Marks the letter `discarded`. Rejects a letter that is missing, and with
   * `DeadLetterSettledError` one that is no longer `failed`.
   */
  discard(id: string): Promise<DeadLetter>;
}

export interface CreateDeadLettersArgs {
  readonly storage: Storage;
  readonly pipeline: CommandPipeline;
  readonly aggregates: AggregatesRuntime;
  readonly policies: PoliciesRuntime;
  readonly policyExecutor: PolicyExecutor;
  readonly processes: ProcessDeadLetters;
  readonly config: ResolvedConfig;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateDeadLettersFunction {
  (args: CreateDeadLettersArgs): DeadLetters;
}

/**
 * A retry bypasses the inbox ledger on purpose: the ledger already says the handler ran, and the
 * operator is asking for another run.
 */
export const createDeadLetters: CreateDeadLettersFunction = ({
  storage,
  pipeline,
  aggregates,
  policies,
  policyExecutor,
  processes,
  config,
  ids,
  clock,
  logger,
}) => {
  // The retry's writes and the letter's new status, together or not at all. A retry that
  // another one settled first writes nothing, and does not run again after a conflict.
  const settled = (letter: DeadLetter, run: (unit: UnitOfWork) => Promise<void>): Promise<void> =>
    commitWork({
      storage,
      concurrencyRetries: config.runtime.commands.concurrencyRetries,
      work: async (unit) => {
        await run(unit);
        await unit.deadLetterStore.updateStatus(letter.id, "retried");
      },
      beforeRerun: async () => {
        const current = await storage.deadLetterStore.get(letter.id);
        if (current?.status !== "failed") throw new DeadLetterSettledError({ id: letter.id });
      },
    });

  const failedLetter = async (id: string): Promise<DeadLetter> => {
    const letter = await storage.deadLetterStore.get(id);
    if (letter === null) throw new NotFoundError(`Dead letter "${id}" not found`);
    if (letter.status !== "failed") {
      throw new DeadLetterSettledError({ id, status: letter.status });
    }
    return letter;
  };

  const eventOf = async (letter: DeadLetter): Promise<StoredEvent> => {
    const { events } = await storage.eventStore.load({
      aggregateType: letter.aggregateType,
      aggregateId: letter.aggregateId,
    });
    const event = events.find((candidate) => candidate.id === letter.eventId);
    if (event === undefined) {
      throw new NotFoundError(
        `Event ${letter.eventId} of ${letter.aggregateType}:${letter.aggregateId} not found`,
      );
    }
    return event;
  };

  const retryPolicy = async (letter: DeadLetter, retryId: string): Promise<void> => {
    const policy = policies.byName[letter.handler];
    if (policy === undefined) {
      throw new DeadLetterNotRetriableError(
        `Policy "${letter.handler}" is no longer in the registry`,
      );
    }
    const event = await eventOf(letter);
    if (event.aggregateType !== policy.source || !policy.on.includes(event.type)) {
      throw new DeadLetterNotRetriableError(
        `Policy "${policy.name}" no longer handles ${event.aggregateType}.${event.type}`,
      );
    }
    await settled(letter, (unit) =>
      policyExecutor.run({ policy, event, attempt: letter.attempts + 1, retryId, within: unit }),
    );
  };

  const retryScheduled = async (letter: DeadLetter): Promise<void> => {
    if (aggregates.commandsByType[letter.eventType] === undefined) {
      throw new DeadLetterNotRetriableError(
        `Command "${letter.eventType}" is no longer in the registry`,
      );
    }
    const context: CausationContext = {
      correlationId: ids.next(),
      causationId: letter.id,
      depth: 0,
    };
    await settled(letter, async (unit) => {
      await pipeline.dispatchUnattended({
        type: letter.eventType,
        payload: letter.payload,
        context,
        within: unit,
      });
    });
  };

  // Resolves to whether the letter still has to be marked retried: a policy, scheduled command
  // or follow-up retry marks it in its own unit; any other process retry leaves it for after the
  // drain.
  const run = async (letter: DeadLetter, retryId: string): Promise<boolean> => {
    switch (letter.kind) {
      case "policy":
        await retryPolicy(letter, retryId);
        return false;
      case "process":
        if (letter.eventType === PROCESS_DEADLINE_COMMAND) {
          await processes.retryDeadline({
            payload: { process: letter.handler, aggregateId: letter.aggregateId },
            context: { correlationId: ids.next(), causationId: letter.id, depth: 0 },
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
        }));
      case "scheduled":
        await retryScheduled(letter);
        return false;
      default:
        // Stores cast the stored kind, so a row no release writes still reaches here.
        throw new DeadLetterNotRetriableError(
          `Dead letter "${letter.id}" has an unknown kind "${String(letter.kind satisfies never)}"`,
        );
    }
  };

  const withParked = async (letter: DeadLetter): Promise<DeadLetter> => {
    if (letter.kind !== "process") return letter;
    return { ...letter, parked: await processes.parkedBehind(letter) };
  };

  return {
    list: async (args) => Promise.all((await storage.deadLetterStore.list(args)).map(withParked)),
    count: (args) => storage.deadLetterStore.count(args),
    get: async (id) => {
      const letter = await storage.deadLetterStore.get(id);
      return letter === null ? null : withParked(letter);
    },
    retry: async (id) => {
      const letter = await failedLetter(id);
      if (await run(letter, ids.next())) await storage.deadLetterStore.updateStatus(id, "retried");
      logger.info("dead letter retried", {
        id,
        kind: letter.kind,
        handler: letter.handler,
        at: clock.now().toISOString(),
      });
      const retried: DeadLetter = { ...letter, status: "retried" };
      if (letter.kind !== "process") return retried;
      return { ...retried, parked: await processes.stillParked(letter) };
    },
    discard: async (id) => {
      const letter = await failedLetter(id);
      await storage.deadLetterStore.updateStatus(id, "discarded");
      logger.info("dead letter discarded", {
        id,
        kind: letter.kind,
        handler: letter.handler,
      });
      return { ...letter, status: "discarded" };
    },
  };
};
