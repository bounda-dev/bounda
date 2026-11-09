import type { StreamIdentity } from "../../contracts/event.ts";
import type { KeyedPerson } from "./personal-key-store.ts";

/**
 * The state of one aggregate stream folded up to `version`, as the kernel serialized it, valid
 * only for the `fingerprint` of the code that folded it. `persons` names the people whose personal
 * fields the events folded carried, since the state holds them in the clear, each with the key
 * they were read under.
 */
export interface Snapshot extends StreamIdentity {
  readonly version: number;
  readonly fingerprint: string;
  readonly state: string;
  readonly persons: readonly KeyedPerson[];
}

/**
 * One snapshot per stream, the last one `put`: a cache of the fold, never the source of truth,
 * so a kernel that finds one missing, stale or doubtful folds the stream from its first event
 * instead. `get` is `null` for a stream without one. `remove` forgets a stream's snapshot.
 *
 * A snapshot holds personal data in the clear, so it lives only as long as its persons' keys stay
 * in force: `put` writes nothing unless every person it names with a fingerprint holds, in the
 * storage's `personalKeys`, the key of that fingerprint in force, neither gone nor retained,
 * checked in the same statement (one named with `null` was read in the clear and needs none); and
 * `forget` removes every snapshot that names the person under a key outside `keep`, or read in the
 * clear, every one that names them without `keep`. A transaction that removes or retains a key and
 * then forgets the snapshots outside the keys still in force leaves none behind, whatever `put`
 * runs beside it, and a key given to the person afterwards is never the one a snapshot was read
 * under. A `put` older than the snapshot of the same fingerprint is ignored.
 */
export interface SnapshotStore {
  get(stream: StreamIdentity): Promise<Snapshot | null>;
  put(snapshot: Snapshot): Promise<void>;
  remove(stream: StreamIdentity): Promise<void>;
  forget(person: string, keep?: readonly string[]): Promise<void>;
}
