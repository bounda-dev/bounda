import type {
  DeadLetterErrorType,
  NewDeadLetter,
} from "../../adapter/storage/dead-letter-store.ts";
import type { PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { sealError } from "../personal-data/errors.ts";
import { personOfEvent } from "../personal-data/persons.ts";
import { restrictedPersonOf } from "../personal-data/refusal.ts";
import { classifyFailure } from "../shared/retry.ts";
import { deadLettered } from "../telemetry.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { PROCESS_DEADLINE_COMMAND } from "./deadlines.ts";
import { type ProcessInstance, processAggregateType } from "./lifecycle.ts";

/**
 * What a process dead letter is about: the event whose handler failed, or a deadline standing in
 * for one, with the person it names, whose key seals the letter's error text.
 */
export interface FailureSubject
  extends Pick<StoredEvent, "id" | "type" | "aggregateType" | "aggregateId"> {
  readonly person: string | null;
}

export interface ProcessFailures {
  /**
   * The event as a letter's subject, naming the person it names.
   */
  subjectOf(event: StoredEvent): FailureSubject;
  /**
   * The letter of the failure, its error text sealed under the subject's person, to stage in a
   * unit's dead letters.
   */
  letterOf(
    process: ProcessRuntime,
    subject: FailureSubject,
    error: unknown,
    attempts: number,
    errorType: DeadLetterErrorType,
  ): Promise<NewDeadLetter>;
  /**
   * Counts and logs `letter` once the unit that filed it committed.
   */
  filed(process: ProcessRuntime, letter: NewDeadLetter): void;
}

export interface CreateProcessFailuresArgs {
  readonly aggregates: AggregatesRuntime;
  readonly keys: PersonalKeyStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateProcessFailuresFunction {
  (args: CreateProcessFailuresArgs): ProcessFailures;
}

export const createProcessFailures: CreateProcessFailuresFunction = ({
  aggregates,
  keys,
  ids,
  clock,
  logger,
}) => ({
  subjectOf: (event) => ({
    id: event.id,
    type: event.type,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    person: personOfEvent({ aggregates, event }),
  }),
  letterOf: async (process, subject, error, attempts, errorType) => {
    const person = restrictedPersonOf(error) ?? subject.person;
    const now = clock.now().toISOString();
    return {
      id: ids.next(),
      kind: "process",
      handler: process.name,
      eventId: subject.id,
      eventType: subject.type,
      aggregateType: subject.aggregateType,
      aggregateId: subject.aggregateId,
      person,
      errorType,
      ...(await sealError({ error, person, keys })),
      attempts,
      firstFailedAt: now,
      lastFailedAt: now,
    };
  },
  filed: (process, letter) => {
    deadLettered(letter);
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
  aggregateType: processAggregateType(process.name),
  aggregateId: instanceId,
  person: null,
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
