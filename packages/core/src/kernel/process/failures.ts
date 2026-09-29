import type {
  DeadLetterErrorType,
  DeadLetterStore,
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

export interface ProcessFailures {
  letterOf(
    process: ProcessRuntime,
    subject: FailureSubject,
    error: unknown,
    attempts: number,
    errorType: DeadLetterErrorType,
  ): NewDeadLetter;
  /**
   * Stages `letter` in `store`, a unit's dead letters, with the error's stack when it has one.
   */
  file(
    store: DeadLetterStore,
    process: ProcessRuntime,
    letter: NewDeadLetter,
    error?: unknown,
  ): Promise<void>;
  /**
   * Counts and logs `letter` once the unit that filed it committed.
   */
  filed(process: ProcessRuntime, letter: NewDeadLetter): void;
}

export interface CreateProcessFailuresArgs {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateProcessFailuresFunction {
  (args: CreateProcessFailuresArgs): ProcessFailures;
}

export const createProcessFailures: CreateProcessFailuresFunction = ({ ids, clock, logger }) => ({
  letterOf: (process, subject, error, attempts, errorType) => {
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
  },
  file: async (store, _process, letter, error) => {
    const stack = error === undefined ? undefined : errorDetails(error).stack;
    await store.add(stack === undefined ? letter : { ...letter, errorStack: stack });
  },
  filed: (process, letter) => {
    deadLettered({ kind: "process", subscriber: process.name, errorType: letter.errorType });
    logger.warn("process dead-lettered", {
      process: process.name,
      eventId: letter.eventId,
      errorType: letter.errorType,
      attempts: letter.attempts,
    });
  },
});

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
  letter === undefined || instance.failure?.letterId === letter;

export interface DrainFailureTypeFunction {
  (error: unknown): DeadLetterErrorType;
}

/**
 * How a step that fails while parked events are drained is filed: nothing retries it there, so a
 * retriable error is filed as exhausted.
 */
export const drainFailureType: DrainFailureTypeFunction = (error) =>
  classifyFailure(error) === "terminal" ? "terminal" : "retriable_exhausted";
