/**
 * The last global position each subscriber of the stream processed; `get` is `0` for one that
 * never checkpointed. `compareAndSet` moves the checkpoint only while it is still at `expected`
 * and reports whether it did, so a pass that lost a race with another process, a rebuild or an
 * operator never overwrites what they wrote. `set` is unconditional, for repositioning on purpose.
 * `remove` forgets a subscriber: `get` reports 0 for it again and `list` leaves it out.
 */
export interface CheckpointStore {
  get(subscriber: string): Promise<number>;
  set(subscriber: string, position: number): Promise<void>;
  compareAndSet(subscriber: string, expected: number, position: number): Promise<boolean>;
  remove(subscriber: string): Promise<void>;
  list(): Promise<readonly Checkpoint[]>;
}

export interface Checkpoint {
  readonly subscriber: string;
  readonly position: number;
}
