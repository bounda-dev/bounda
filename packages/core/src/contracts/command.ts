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
 * Options accepted when dispatching a command.
 *
 * `delay` schedules the command instead of executing it now. `correlationId` overrides the
 * generated correlation id for commands that start a new request from outside the runtime.
 */
export interface DispatchOptions {
  readonly delay?: DurationInput;
  readonly correlationId?: string;
}

/**
 * What a successful dispatch returns: the aggregate version after the append and the persisted
 * events, with their types in the same order and the position of the last one in the global stream, 0 when
 * the command stored none. A read model that has projected up to `position` reflects the command.
 * Scheduled commands return `scheduled: true` and no events.
 */
export type DispatchResult =
  | {
      readonly scheduled: false;
      readonly aggregateId: string;
      readonly version: number;
      readonly eventIds: readonly string[];
      readonly eventTypes: readonly string[];
      readonly position: number;
    }
  | {
      readonly scheduled: true;
      readonly aggregateId: string;
      readonly executeAt: string;
    };
