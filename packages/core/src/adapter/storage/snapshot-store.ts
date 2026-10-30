import type { StreamIdentity } from "../../contracts/event.ts";

/**
 * The state of one aggregate stream folded up to `version`, as the kernel serialized it, valid
 * only for the `fingerprint` of the code that folded it. `persons` names, once each, the people
 * whose personal fields the events folded carried, since the state holds them in the clear.
 */
export interface Snapshot extends StreamIdentity {
  readonly version: number;
  readonly fingerprint: string;
  readonly state: string;
  readonly persons: readonly string[];
}

/**
 * One snapshot per stream, the last one `put`: a cache of the fold, never the source of truth,
 * so a kernel that finds one missing, stale or doubtful folds the stream from its first event
 * instead. `get` is `null` for a stream without one. `remove` forgets a stream's snapshot.
 *
 * A snapshot holds personal data in the clear, so it lives only as long as its persons' keys:
 * `put` writes nothing unless every person it names has a key in the storage's `personalKeys`,
 * checked in the same statement, and `forget` removes every snapshot that names a person. A
 * transaction that removes a key and then forgets its snapshots leaves none behind, whatever
 * `put` runs beside it.
 */
export interface SnapshotStore {
  get(stream: StreamIdentity): Promise<Snapshot | null>;
  put(snapshot: Snapshot): Promise<void>;
  remove(stream: StreamIdentity): Promise<void>;
  forget(person: string): Promise<void>;
}
