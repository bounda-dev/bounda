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
 * What a command dispatched from a policy or process handler resolves with: the aggregate's
 * version after the command's events and those events' ids and types, in order, or
 * `scheduled: true` with when a delayed command runs. It is the aggregate's decision, kept in the
 * handler's unit of work until its attempt commits, so it carries no position in the global
 * stream: nothing is stored yet.
 */
export type ReactionDispatchResult =
  | {
      readonly scheduled: false;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly version: number;
      readonly eventIds: readonly string[];
      readonly eventTypes: readonly string[];
    }
  | {
      readonly scheduled: true;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly executeAt: string;
    };

/**
 * What a successful dispatch returns: the aggregate's version after the append and the ids and
 * types of the persisted events, in order. `position` is the global position of the last one, 0
 * when the command stored none; a read model projected up to it reflects the command. A
 * scheduled command returns `scheduled: true` and no events.
 */
export type DispatchResult =
  | (Extract<ReactionDispatchResult, { readonly scheduled: false }> & {
      readonly position: number;
    })
  | Extract<ReactionDispatchResult, { readonly scheduled: true }>;
