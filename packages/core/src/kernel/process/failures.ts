import type { StoragePorts } from "../../adapter/adapter.ts";
import type {
  DeadLetter,
  DeadLetterErrorType,
  NewDeadLetter,
} from "../../adapter/ports/dead-letter-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import { classifyFailure, errorDetails } from "../shared/retry.ts";
import { deadLettered } from "../telemetry.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { PROCESS_DEADLINE_COMMAND } from "./deadlines.ts";
import { type ProcessInstance, processAggregateType } from "./lifecycle.ts";

/**
 * What a process dead letter is about: the event whose handler failed, or a deadline standing in
 * for one.
 */
export type FailureSubject = Pick<StoredEvent, "id" | "type" | "aggregateType" | "aggregateId">;

/**
 * The dead letters of process failures.
 */
export interface ProcessFailures {
  letterOf(
    process: ProcessRuntime,
    subject: FailureSubject,
    error: unknown,
    attempts: number,
    errorType: DeadLetterErrorType,
  ): NewDeadLetter;
  file(process: ProcessRuntime, letter: NewDeadLetter, error?: unknown): Promise<void>;
  /**
   * Files `letter`, or leaves it to be filed when the instance is next reached if filing fails:
   * the `ProcessFailed` already written carries it.
   */
  fileLater(process: ProcessRuntime, letter: NewDeadLetter, error: unknown): Promise<void>;
  /**
   * Files the letter of a failed instance whose filing was cut short. Resolves to the letter when
   * it was already filed.
   */
  healFailure(process: ProcessRuntime, instance: ProcessInstance): Promise<DeadLetter | null>;
}

export interface CreateProcessFailuresArgs {
  readonly storage: StoragePorts;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateProcessFailuresFunction {
  (args: CreateProcessFailuresArgs): ProcessFailures;
}

export const createProcessFailures: CreateProcessFailuresFunction = ({
  storage,
  ids,
  clock,
  logger,
}) => {
  const letterOf = (
    process: ProcessRuntime,
    subject: FailureSubject,
    error: unknown,
    attempts: number,
    errorType: DeadLetterErrorType,
  ): NewDeadLetter => {
    const now = clock.now().toISOString();
    return {
      id: ids.next(),
      kind: "process",
      subscriber: process.name,
      eventId: subject.id,
      eventType: subject.type,
      aggregateType: subject.aggregateType,
      aggregateId: subject.aggregateId,
      errorType,
      errorMessage: errorDetails(error).message,
      attempts,
      firstFailedAt: now,
      lastFailedAt: now,
    };
  };

  const file = async (
    process: ProcessRuntime,
    letter: NewDeadLetter,
    error?: unknown,
  ): Promise<void> => {
    const stack = error === undefined ? undefined : errorDetails(error).stack;
    await storage.deadLetterStore.add(
      stack === undefined ? letter : { ...letter, errorStack: stack },
    );
    deadLettered({ kind: "process", subscriber: process.name, errorType: letter.errorType });
    logger.warn("process dead-lettered", {
      process: process.name,
      eventId: letter.eventId,
      errorType: letter.errorType,
      attempts: letter.attempts,
    });
  };

  const fileLater = (
    process: ProcessRuntime,
    letter: NewDeadLetter,
    error: unknown,
  ): Promise<void> =>
    file(process, letter, error).catch((filing: unknown) => {
      logger.warn("process dead letter not filed yet; it is filed when the instance is reached", {
        process: process.name,
        letter: letter.id,
        error: errorDetails(filing).message,
      });
    });

  const healFailure = async (
    process: ProcessRuntime,
    instance: ProcessInstance,
  ): Promise<DeadLetter | null> => {
    const letter = instance.status === "failed" ? instance.failure?.letter : undefined;
    if (letter === undefined) return null;
    const filed = await storage.deadLetterStore.get(letter.id);
    if (filed !== null) return filed;
    await file(process, letter);
    return null;
  };

  return { letterOf, file, fileLater, healFailure };
};

export interface DeadlineSubjectFunction {
  (process: ProcessRuntime, instanceId: string, field: string): FailureSubject;
}

/**
 * How a failed deadline is recorded in a dead letter, where an event would be.
 */
export const deadlineSubject: DeadlineSubjectFunction = (process, instanceId, field) => ({
  id: `deadline:${field}`,
  type: PROCESS_DEADLINE_COMMAND,
  aggregateType: processAggregateType(process.type),
  aggregateId: instanceId,
});

export interface BlockedOnFunction {
  (instance: ProcessInstance, letter: string | undefined): boolean;
}

/**
 * Whether the instance's failure is the one the dead letter `letter` records; any failure when no
 * letter is named.
 */
export const blockedOn: BlockedOnFunction = (instance, letter) =>
  letter === undefined || instance.failure?.letter?.id === letter;

export interface DrainFailureTypeFunction {
  (error: unknown): DeadLetterErrorType;
}

/**
 * How a step that fails while parked events are drained is filed: nothing retries it there, so a
 * retriable error is filed as exhausted.
 */
export const drainFailureType: DrainFailureTypeFunction = (error) =>
  classifyFailure(error) === "terminal" ? "terminal" : "retriable_exhausted";
