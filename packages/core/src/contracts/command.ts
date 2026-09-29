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
}

/**
 * What a successful dispatch returns: the aggregate's version after the append and the ids and
 * types of the persisted events, in order. `position` is the global position of the last one, 0
 * when the command stored none; a read model projected up to it reflects the command. A
 * scheduled command returns `scheduled: true` and no events.
 */
export type DispatchResult =
  | {
      readonly scheduled: false;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly version: number;
      readonly eventIds: readonly string[];
      readonly eventTypes: readonly string[];
      readonly position: number;
    }
  | {
      readonly scheduled: true;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly executeAt: string;
    };
