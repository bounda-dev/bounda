import type { EventMetadata } from "./metadata.ts";

/**
 * An event produced by a command handler, before it is persisted.
 */
export interface NewEvent<Type extends string = string, Payload = unknown> {
  readonly type: Type;
  readonly payload: Payload;
}

/**
 * An event as it exists in the event store: a `NewEvent` plus identity, position in its stream,
 * position in the global stream, and causal metadata.
 */
export interface StoredEvent<Type extends string = string, Payload = unknown>
  extends NewEvent<Type, Payload> {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly position: number;
  readonly timestamp: string;
  readonly metadata: EventMetadata;
}

/**
 * Identifies one stream in the event store. Aggregates use their type and id; processes use the
 * `process:` prefix so they never collide with a domain aggregate of the same name.
 */
export interface StreamIdentity {
  readonly aggregateType: string;
  readonly aggregateId: string;
}

export type StreamIdFunction = (identity: StreamIdentity) => string;

/**
 * Builds the canonical stream id for an aggregate.
 */
export const streamId: StreamIdFunction = ({ aggregateType, aggregateId }) =>
  `${aggregateType}:${aggregateId}`;

/**
 * Prefix used by the runtime for the internal streams that hold process state.
 */
export const PROCESS_STREAM_PREFIX: "process" = "process";

export type ProcessStreamIdFunction = (args: {
  readonly processType: string;
  readonly aggregateId: string;
}) => string;

/**
 * Builds the stream id of a process instance. A process is keyed by its type and the aggregate
 * id that started it.
 */
export const processStreamId: ProcessStreamIdFunction = ({ processType, aggregateId }) =>
  `${PROCESS_STREAM_PREFIX}:${processType}:${aggregateId}`;
