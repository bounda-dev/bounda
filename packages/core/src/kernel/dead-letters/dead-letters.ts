import type { StoragePorts } from "../../adapter/adapter.ts";
import type { DeadLetter, ListDeadLettersArgs } from "../../adapter/ports/dead-letter-store.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConfigurationError, NotFoundError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { createCommandsFacade } from "../command/facade.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import type { PoliciesRuntime } from "../policy/build-policies.ts";
import { PROCESS_TIMEOUT_COMMAND, type ProcessRunner } from "../process/runner.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { withTimeout } from "../shared/timeout.ts";

/**
 * What an operator can do with the handler runs that gave up. `list`, `count` and `get` read the
 * store; `replay` runs the failed handler again and marks the letter `replayed` when it
 * succeeds; `discard` marks it `discarded`. Both leave the row in place as a record.
 */
export interface DeadLetters {
  list(args?: ListDeadLettersArgs): Promise<readonly DeadLetter[]>;
  count(args?: ListDeadLettersArgs): Promise<number>;
  get(id: string): Promise<DeadLetter | null>;
  /**
   * Runs the failed handler once more: the policy or process handler for the stored event, or
   * the dropped command with its recorded payload. Rejects with the handler's error when it
   * fails again, and the letter stays `failed`.
   */
  replay(id: string): Promise<DeadLetter>;
  discard(id: string): Promise<DeadLetter>;
}

export interface CreateDeadLettersArgs {
  readonly storage: StoragePorts;
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly policies: PoliciesRuntime;
  readonly processes: ProcessRunner;
  readonly config: ResolvedConfig;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateDeadLettersFunction {
  (args: CreateDeadLettersArgs): DeadLetters;
}

const contextOf = (event: StoredEvent): CausationContext => ({
  correlationId: event.metadata.correlationId,
  causationId: event.id,
  depth: event.metadata.depth,
});

/**
 * Wires `app.deadLetters` over the storage and the runners. A replay bypasses the inbox ledger on
 * purpose: the ledger already says the handler ran, and the operator is asking for another run.
 */
export const createDeadLetters: CreateDeadLettersFunction = ({
  storage,
  aggregates,
  pipeline,
  policies,
  processes,
  config,
  ids,
  clock,
  logger,
}) => {
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
    const policy = policies.all.find((candidate) => candidate.name === letter.subscriber);
    if (policy === undefined) {
      throw new ConfigurationError(`Policy "${letter.subscriber}" is no longer in the registry`);
    }
    const event = await eventOf(letter);
    const commands = createCommandsFacade({ aggregates, pipeline, context: contextOf(event) });
    await withTimeout({
      run: () =>
        policy.handler({
          ...policy.collaborators,
          event,
          commands,
          idempotencyKey: deriveIdempotencyKey({
            kind: "policy",
            handler: policy.name,
            subject: event.id,
            replay,
          }),
        }),
      timeoutMs: config.forAggregate(policy.aggregate).policies.timeoutMs,
      subject: `policy ${policy.name}`,
      clock,
    });
  };

  const replayCommand = async (letter: DeadLetter, replay: string): Promise<void> => {
    const context: CausationContext = {
      correlationId: ids.next(),
      causationId: letter.id,
      depth: 0,
    };
    if (letter.eventType === PROCESS_TIMEOUT_COMMAND) {
      await processes.handleTimeout({
        payload: { process: letter.aggregateType, aggregateId: letter.aggregateId },
        context,
        replay,
      });
      return;
    }
    if (letter.payload === undefined) {
      throw new ConfigurationError(
        `Dead letter "${letter.id}" was recorded without the command's payload and cannot be replayed`,
      );
    }
    await pipeline.dispatch({ type: letter.eventType, payload: letter.payload, context });
  };

  const run = async (letter: DeadLetter, replay: string): Promise<void> => {
    switch (letter.kind) {
      case "policy":
        return replayPolicy(letter, replay);
      case "process":
        return processes.replay({
          process: letter.subscriber,
          event: await eventOf(letter),
          replay,
        });
      case "command":
        return replayCommand(letter, replay);
      case "projection":
        throw new ConfigurationError(
          `Dead letter "${letter.id}" is a projection failure; rebuild the read model instead`,
        );
    }
  };

  return {
    list: (args) => storage.deadLetterStore.list(args),
    count: (args) => storage.deadLetterStore.count(args),
    get: (id) => storage.deadLetterStore.get(id),
    replay: async (id) => {
      const letter = await failedLetter(id);
      await run(letter, ids.next());
      await storage.deadLetterStore.updateStatus(id, "replayed");
      logger.info("dead letter replayed", {
        id,
        kind: letter.kind,
        subscriber: letter.subscriber,
        at: clock.now().toISOString(),
      });
      return { ...letter, status: "replayed" };
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
