import type { StoragePorts } from "../../adapter/adapter.ts";
import type { DeadLetter, ListDeadLettersArgs } from "../../adapter/ports/dead-letter-store.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import {
  ConfigurationError,
  DeadLetterSettledError,
  NotFoundError,
} from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import type { PoliciesRuntime } from "../policy/build-policies.ts";
import type { PolicyExecutor } from "../policy/executor.ts";
import { PROCESS_DEADLINE_COMMAND } from "../process/deadlines.ts";
import type { ProcessDeadLetters } from "../process/replay.ts";
import { commitWork, type UnitOfWork } from "../unit-of-work/unit-of-work.ts";

/**
 * What an operator can do with the handler runs that gave up. Replaying or discarding a letter
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
   * process deadline that failed, or the dropped command with its recorded payload, and marks the
   * letter `replayed`: a policy's or a command's in the same transaction as what the run writes,
   * a process's once its instance has drained what was parked, since a replay cut short there is
   * taken up again by replaying the same letter. Rejects with the handler's error when it fails
   * again, and the letter stays `failed`. Rejects, without running anything, a letter that is
   * missing or no longer `failed`, a projection letter (a rebuild of the read model fixes it
   * instead), a letter whose policy is no longer in the registry or whose event is gone, and a
   * command letter recorded without its payload. Rejects with `DeadLetterSettledError` when
   * another replay or a discard of the same letter settled it while this one ran; a policy's or a
   * command's replay then writes nothing.
   */
  replay(id: string): Promise<DeadLetter>;
  /**
   * Marks the letter `discarded`. Rejects a letter that is missing or no longer `failed`, with
   * `DeadLetterSettledError` when a replay or another discard settled it meanwhile.
   */
  discard(id: string): Promise<DeadLetter>;
}

export interface CreateDeadLettersArgs {
  readonly storage: StoragePorts;
  readonly pipeline: CommandPipeline;
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
 * A replay bypasses the inbox ledger on purpose: the ledger already says the handler ran, and the
 * operator is asking for another run.
 */
export const createDeadLetters: CreateDeadLettersFunction = ({
  storage,
  pipeline,
  policies,
  policyExecutor,
  processes,
  config,
  ids,
  clock,
  logger,
}) => {
  // The replay's writes and the letter's new status, together or not at all. A replay that
  // another one settled first writes nothing, and does not run again after a conflict.
  const replayed = (letter: DeadLetter, run: (unit: UnitOfWork) => Promise<void>): Promise<void> =>
    commitWork({
      storage,
      concurrencyRetries: config.runtime.commands.concurrencyRetries,
      work: async (unit) => {
        await run(unit);
        await unit.deadLetterStore.updateStatus(letter.id, "replayed");
      },
      beforeRerun: async () => {
        const current = await storage.deadLetterStore.get(letter.id);
        if (current?.status !== "failed") throw new DeadLetterSettledError(letter.id);
      },
    });

  const failedLetter = async (id: string): Promise<DeadLetter> => {
    const letter = await storage.deadLetterStore.get(id);
    if (letter === null) throw new NotFoundError(`Dead letter "${id}" not found`);
    if (letter.status !== "failed") {
      throw new ConfigurationError(`Dead letter "${id}" was already ${letter.status}`);
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

  const replayPolicy = async (letter: DeadLetter, replay: string): Promise<void> => {
    const policy = policies.byName[letter.subscriber];
    if (policy === undefined) {
      throw new ConfigurationError(`Policy "${letter.subscriber}" is no longer in the registry`);
    }
    const event = await eventOf(letter);
    await replayed(letter, (unit) =>
      policyExecutor.run({ policy, event, attempt: letter.attempts + 1, replay, within: unit }),
    );
  };

  const replayCommand = async (letter: DeadLetter): Promise<void> => {
    const context: CausationContext = {
      correlationId: ids.next(),
      causationId: letter.id,
      depth: 0,
    };
    if (letter.payload === undefined) {
      throw new ConfigurationError(
        `Dead letter "${letter.id}" was recorded without the command's payload and cannot be replayed`,
      );
    }
    const { payload } = letter;
    await replayed(letter, async (unit) => {
      await pipeline.dispatch({ type: letter.eventType, payload, context, within: unit });
    });
  };

  const run = async (letter: DeadLetter, replay: string): Promise<void> => {
    switch (letter.kind) {
      case "policy":
        return replayPolicy(letter, replay);
      case "process":
        if (letter.eventType === PROCESS_DEADLINE_COMMAND) {
          return processes.replayDeadline({
            payload: { process: letter.subscriber, aggregateId: letter.aggregateId },
            context: { correlationId: ids.next(), causationId: letter.id, depth: 0 },
            replay,
            letter: letter.id,
          });
        }
        return processes.replay({
          process: letter.subscriber,
          event: await eventOf(letter),
          replay,
          letter: letter.id,
        });
      case "command":
        return replayCommand(letter);
      case "projection":
        throw new ConfigurationError(
          `Dead letter "${letter.id}" is a projection failure; rebuild the read model instead`,
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
    replay: async (id) => {
      const letter = await failedLetter(id);
      await run(letter, ids.next());
      if (letter.kind === "process") await storage.deadLetterStore.updateStatus(id, "replayed");
      logger.info("dead letter replayed", {
        id,
        kind: letter.kind,
        subscriber: letter.subscriber,
        at: clock.now().toISOString(),
      });
      const replayed: DeadLetter = { ...letter, status: "replayed" };
      if (letter.kind !== "process") return replayed;
      return { ...replayed, parked: await processes.stillParked(letter) };
    },
    discard: async (id) => {
      const letter = await failedLetter(id);
      await storage.deadLetterStore.updateStatus(id, "discarded");
      logger.info("dead letter discarded", {
        id,
        kind: letter.kind,
        subscriber: letter.subscriber,
      });
      return { ...letter, status: "discarded" };
    },
  };
};
