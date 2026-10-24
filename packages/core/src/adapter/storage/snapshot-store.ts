import type { StreamIdentity } from "../../contracts/event.ts";

/**
 * The state of one aggregate stream folded up to `version`, as the kernel serialized it, valid
 * only for the `fingerprint` of the code that folded it.
 */
export interface Snapshot extends StreamIdentity {
  readonly version: number;
  readonly fingerprint: string;
  readonly state: string;
}

/**
 * One snapshot per stream, the last one `put`: a cache of the fold, never the source of truth,
 * so a kernel that finds one missing, stale or doubtful folds the stream from its first event
 * instead. `get` is `null` for a stream without one. `remove` forgets a stream's snapshot.
 */
export interface SnapshotStore {
  get(stream: StreamIdentity): Promise<Snapshot | null>;
  put(snapshot: Snapshot): Promise<void>;
  remove(stream: StreamIdentity): Promise<void>;
}
