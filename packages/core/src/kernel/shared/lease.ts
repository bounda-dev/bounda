import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";

// How long the instance running a background job holds it without renewing it, which it does
// whenever half of it is spent.
export const LEASE_MS = 120_000;

export interface Lease {
  /**
   * Resolves whether this instance runs the job at `at`: it holds the lease, renewed once half of
   * it is spent, or took it once it lapsed. Asked before each item of a pass, so an instance
   * whose lease lapsed while it was stalled stops at the next one.
   */
  take(at: number): Promise<boolean>;
  /**
   * Until when another instance held the lease, as the last `take` read it; `-Infinity` when
   * none did.
   */
  heldElsewhereUntil(): number;
  /**
   * Gives the lease back when this instance holds it, so another runs the job at once instead of
   * waiting for it to lapse. Never rejects.
   */
  release(): Promise<void>;
  /**
   * Forgets what this instance knew of the lease, as after the database went back to a copy:
   * the next `take` reads it afresh, and takes as its own a lease of its own the copy brought back.
   */
  reset(): void;
}

export interface CreateLeaseArgs {
  readonly checkpoints: CheckpointStore;
  /**
   * The checkpoint row that keeps, in milliseconds, until when the lease is held.
   */
  readonly row: string;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateLeaseFunction {
  (args: CreateLeaseArgs): Lease;
}

// How many of the leases an instance wrote last it still knows as its own: a copy restored within a
// lease brings back one of them, at most this many renewals old.
const OWN_LEASES_KEPT = 4;

/**
 * One instance runs a job at a time: the one whose `compareAndSet` of the row took the lease.
 * A lease more than a lease ahead was written by a clock that runs ahead, and is taken.
 */
export const createLease: CreateLeaseFunction = ({ checkpoints, row, clock, logger }) => {
  let held: number | null = null;
  let written: readonly number[] = [];
  let elsewhereUntil = Number.NEGATIVE_INFINITY;

  return {
    take: async (at) => {
      const stored = await checkpoints.get(row);
      if (stored === held && stored - at > LEASE_MS / 2) return true;
      const ours = stored === held || written.includes(stored);
      if (!ours && stored > at && stored <= at + LEASE_MS) {
        held = null;
        elsewhereUntil = stored;
        return false;
      }
      const until = at + LEASE_MS;
      if (!(await checkpoints.compareAndSet(row, stored, until))) {
        held = null;
        return false;
      }
      held = until;
      written = [...written.slice(1 - OWN_LEASES_KEPT), until];
      elsewhereUntil = Number.NEGATIVE_INFINITY;
      return true;
    },
    heldElsewhereUntil: () => elsewhereUntil,
    // Lapsed now rather than removed, so a row that names a configuration stays while instances
    // may run it.
    release: async () => {
      if (held === null) return;
      const until = held;
      held = null;
      const lapsed = Math.min(until, clock.now().getTime());
      await checkpoints.compareAndSet(row, until, lapsed).catch((error: unknown) => {
        logger.error("background job could not give its lease back", { lease: row, error });
      });
    },
    reset: () => {
      held = null;
      elsewhereUntil = Number.NEGATIVE_INFINITY;
    },
  };
};
