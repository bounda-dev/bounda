import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";

const STREAM_MARK_PREFIX = "restore:event:";
const REACHED_PREFIX = "restore:reached:";

export interface SubscriberRowFunction {
  (subscriber: string): string;
}

/**
 * The row, beside a subscriber's checkpoint in a read model's database of its own, that names the
 * event at the checkpoint by `eventMark`: what tells whether the stream still holds what the
 * subscriber read, since positions are taken again after a restore.
 */
export const streamMarkOf: SubscriberRowFunction = (subscriber) =>
  `${STREAM_MARK_PREFIX}${subscriber}`;

/**
 * The row, in the storage's database, of the furthest checkpoint the instances saw that subscriber
 * of a read model's own database reach: a checkpoint behind it went back with a copy.
 */
export const reachedOf: SubscriberRowFunction = (subscriber) => `${REACHED_PREFIX}${subscriber}`;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MARK_BITS = (1n << 52n) - 1n;

export interface EventMarkFunction {
  (id: string): number;
}

/**
 * An event's id as a number a checkpoint holds exactly: 52 bits of its 64-bit FNV-1a.
 */
export const eventMark: EventMarkFunction = (id) => {
  let hash = FNV_OFFSET;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash ^ BigInt(id.charCodeAt(index))) * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return Number(hash & MARK_BITS);
};

export interface MarkedCompareAndSetArgs {
  readonly checkpoints: CheckpointStore;
  readonly subscriber: string;
  /**
   * The batch whose last event the checkpoint moves to.
   */
  readonly events: readonly StoredEvent[];
}

export interface MarkedCompareAndSetFunction {
  (args: MarkedCompareAndSetArgs): (expected: number, position: number) => Promise<boolean>;
}

/**
 * A checkpoint's compare-and-set that, in the same transaction, marks the event it moved to.
 */
export const markedCompareAndSet: MarkedCompareAndSetFunction =
  ({ checkpoints, subscriber, events }) =>
  async (expected, position) => {
    if (!(await checkpoints.compareAndSet(subscriber, expected, position))) return false;
    const event = events.find((candidate) => candidate.position === position);
    if (event !== undefined) await checkpoints.set(streamMarkOf(subscriber), eventMark(event.id));
    return true;
  };
