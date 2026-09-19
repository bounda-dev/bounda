/**
 * Where each subscriber of the global stream (a projection, the policy runner, the process runner)
 * remembers the last position it processed. `get` returns `0` for a subscriber that has never
 * checkpointed.
 */
export interface CheckpointStore {
  get(subscriber: string): Promise<number>;
  set(subscriber: string, position: number): Promise<void>;
  list(): Promise<readonly Checkpoint[]>;
}

export interface Checkpoint {
  readonly subscriber: string;
  readonly position: number;
}
