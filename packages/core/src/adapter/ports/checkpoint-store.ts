/**
 * Where each subscriber of the global stream (a projection, the policy runner, the process runner)
 * remembers the last position it processed. `get` returns `0` for a subscriber that has never
 * checkpointed.
 *
 * `compareAndSet` is how the dispatcher advances: it moves the checkpoint to `position` only if it
 * is still at `expected`, and reports whether it did. A pass that read position 1000 and finds the
 * checkpoint somewhere else when it comes back has lost a race with another process, a rebuild
 * or an operator, and must not overwrite what they wrote. `set` is unconditional and is for
 * repositioning on purpose.
 */
export interface CheckpointStore {
  get(subscriber: string): Promise<number>;
  set(subscriber: string, position: number): Promise<void>;
  compareAndSet(subscriber: string, expected: number, position: number): Promise<boolean>;
  list(): Promise<readonly Checkpoint[]>;
}

export interface Checkpoint {
  readonly subscriber: string;
  readonly position: number;
}
