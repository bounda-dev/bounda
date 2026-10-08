import type { DurationInput } from "./duration.ts";
import type { CommandMetadata } from "./metadata.ts";

/**
 * A command as a handler receives it: type, validated payload, target aggregate and metadata.
 */
export interface Command<Type extends string = string, Payload = unknown> {
  readonly type: Type;
  readonly payload: Payload;
  readonly aggregateId: string;
  readonly metadata: CommandMetadata;
}

/**
 * A command before the runtime enriches it. This is what facades and policies produce.
 */
export interface NewCommand<Type extends string = string, Payload = unknown> {
  readonly type: Type;
  readonly payload: Payload;
  readonly aggregateId: string;
}

/**
 * `delay` schedules the command instead of executing it now. `correlationId` overrides the
 * generated correlation id, for a command that starts a new request from outside the runtime.
 */
export interface DispatchOptions {
  readonly delay?: DurationInput;
  readonly correlationId?: string;
  /**
   * Withdraws the command until its events start being stored: the handler's `signal` aborts and
   * the dispatch rejects with the signal's `reason`, storing nothing. Already aborted, the handler
   * never runs. With `delay`, it only counts before the command is scheduled.
   */
  readonly signal?: AbortSignal;
}

/**
 * A command's rejection as a policy or process handler receives it: the code its handler passed
 * to `reject` and the message. Nothing was decided, so it carries no events.
 */
export interface RejectedDispatch<Code extends string = string> {
  readonly rejected: Code;
  readonly message: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
}

/**
 * A command a policy or process handler dispatched without `delay`, as its aggregate decided it:
 * the aggregate's version after the command's events and those events' ids and types, in order.
 * The decision is kept in the handler's unit of work until its attempt commits, so it carries no
 * position in the global stream: nothing is stored yet.
 */
export interface DecidedDispatch {
  readonly rejected: false;
  readonly scheduled: false;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly eventIds: readonly string[];
  readonly eventTypes: readonly string[];
}

/**
 * What a command dispatched from a policy or process handler resolves with. `rejected` is `false`
 * when the aggregate decided (`DecidedDispatch`), or when a command with `delay` was scheduled. It
 * is the code of the rejection otherwise, one of those the command declares in `rejections`. A
 * call without `delay` is typed without the scheduled case, and one with `delay` with that case
 * alone: the command is rejected, if at all, when it runs. A rejection the handler does not look
 * at changes nothing: the run goes on. The promise rejects only for a failure, which fails the
 * run, and with `REACTION_FINISHED` for a command dispatched once the run has finished, which is
 * logged and decides nothing.
 */
export type ReactionDispatchResult<Code extends string = string> =
  | DecidedDispatch
  | (ScheduledDispatch & { readonly rejected: false })
  | (Code extends string ? RejectedDispatch<Code> : never);

/**
 * A rejection a command dispatched from a policy, a process, the scheduler or a dead letter's
 * replay met, where no caller was waiting for it: `type` is the command's.
 */
export interface CommandRejection extends RejectedDispatch {
  readonly type: string;
}

/**
 * A command dispatched without `delay`, once stored: the aggregate's version after the append and
 * the ids and types of the persisted events, in order. `position` is the global position of the
 * last one, 0 when the command stored none; a read model projected up to it reflects the command.
 */
export interface StoredDispatch {
  readonly scheduled: false;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly eventIds: readonly string[];
  readonly eventTypes: readonly string[];
  readonly position: number;
}

/**
 * A command dispatched with `delay`: nothing ran yet, and `executeAt` says when it will.
 */
export interface ScheduledDispatch {
  readonly scheduled: true;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly executeAt: string;
}

/**
 * What a successful dispatch returns. A call without `delay` is typed `StoredDispatch`, one with
 * `delay` `ScheduledDispatch`; this union is for options whose `delay` the compiler cannot know.
 */
export type DispatchResult = StoredDispatch | ScheduledDispatch;
