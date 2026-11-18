import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { IndexKeyStore } from "../../adapter/storage/index-key-store.ts";
import type {
  PersonalKeyRow,
  PersonalKeyStore,
  StoredPersonalKey,
} from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import { digest } from "../read-model/fingerprint.ts";
import { createLease } from "../shared/lease.ts";
import { createPause, holdAfter } from "./hold.ts";
import type { CryptoKeyWrapper } from "./key-wrapper.ts";
import type { PersonalDataReseal, ResealStatus } from "./reseal.ts";
import type { TenantKeys } from "./tenant-keys.ts";
import type { PersonalKeyWrapping } from "./wrapped-keys.ts";

// How many keys a pass of the worker rewraps at most.
export const ROTATION_BATCH = 50;

// How long a rotation found complete stands before a pass reads the key table again, across every
// instance: a key an instance still on an older configuration wraps meanwhile, as in a rolling
// deploy, waits this long.
export const ROTATION_CHECK_INTERVAL_MS = 60_000;

/**
 * The checkpoint rows that say the rotation is complete, one per set of wrapping keys, named
 * after the set's digest: each keeps, in milliseconds, when the key table was last found with
 * nothing left to rewrap under that set, so another set of keys reads the table again.
 */
export const ROTATED_PREFIX = "personal-keys:rotated:";

// How old the mark of another set of wrapping keys must be before a rotation completing removes
// it: a set some instance still runs is checked, and its mark renewed, every
// `ROTATION_CHECK_INTERVAL_MS`, so a mark this old is no running instance's.
export const ROTATION_MARK_EXPIRY_MS: number = 10 * ROTATION_CHECK_INTERVAL_MS;

/**
 * The checkpoint rows of the lease each set of wrapping keys rotates under, named after the set's
 * digest as its mark is: one instance rewraps at a time.
 */
export const ROTATION_LEASE_PREFIX = "personal-keys:rotating:";

/**
 * Where the rotation of the keys under the tenant's key stands.
 */
export interface KeyRotationStatus {
  /**
   * The version of the tenant's key in force.
   */
  readonly kid: string;
  /**
   * The older versions the tenant key store still holds, which `retireTenantKeys` removes once
   * nothing is wrapped under them.
   */
  readonly previous: readonly string[];
  /**
   * How many keys are left to rewrap under the version in force, held ones included: under an
   * older version, or stored before tenant keys under a master key or none.
   */
  readonly pending: number;
  /**
   * When a pass last found none left, `null` while one is.
   */
  readonly completeAt: string | null;
  /**
   * Where the reseal under way, or the last, stands: `null` when the tenant's data was never
   * resealed.
   */
  readonly reseal: ResealStatus | null;
}

export interface KeyRotation {
  /**
   * Rewraps under the master key in force the versions of the tenant's key wrapped under a
   * previous one, then under the tenant's key in force up to `ROTATION_BATCH` keys wrapped under
   * anything else, and not held, and resolves to how many persons' keys it rewrapped. Never
   * rejects: a key that failed is logged and held on its row, longer after each failure.
   */
  sweep(now: Date): Promise<number>;
  /**
   * When the next pass has a key to rewrap, a held one not before its hold ends; `null` when there
   * is none, and without reading the key table once the rotation is complete.
   */
  nextDueAt(): Promise<Date | null>;
  status(): Promise<KeyRotationStatus>;
  /**
   * Whether no key is left wrapped under a previous version of the tenant's key, read now.
   */
  settled(): Promise<boolean>;
  /**
   * Gives the lease back when this instance holds it. Never rejects.
   */
  release(): Promise<void>;
  /**
   * After the database went back to a copy: forgets what this instance knew of the rotation, and,
   * when `first`, clears the holds of the keys the copy brought back. Never rejects.
   */
  restored(first: boolean): Promise<void>;
}

export interface CreateKeyRotationArgs {
  /**
   * The store as written, whose keys are read and written wrapped.
   */
  readonly keys: PersonalKeyStore;
  /**
   * The database's key, rewrapped with the persons' keys.
   */
  readonly indexKeys?: IndexKeyStore;
  readonly checkpoints: CheckpointStore;
  readonly tenantKeys: Pick<TenantKeys, "kids" | "rewrapUnderMaster" | "underPreviousMaster">;
  readonly master: Pick<CryptoKeyWrapper, "kid" | "previous">;
  readonly wrapping: Pick<PersonalKeyWrapping, "kids" | "wrapped">;
  /**
   * While a reseal replaces the persons' keys, the rotation replaces those it finds rather than
   * rewrapping them.
   */
  readonly reseal?:
    | Pick<PersonalDataReseal, "active" | "replacing" | "replace" | "status">
    | undefined;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateKeyRotationFunction {
  (args: CreateKeyRotationArgs): KeyRotation;
}

const digestOf = (kid: string, previous: readonly (string | null)[]): string =>
  digest(JSON.stringify([kid, ...[...new Set(previous)].sort()]));

interface Answer {
  readonly next: number | null;
  readonly until: number;
}

// The keys to rewrap as the tenant's key stands now, and the rows that mark and lease it.
interface RotationSet {
  readonly kid: string;
  // The tenant's older versions alone.
  readonly versions: readonly string[];
  readonly kids: readonly (string | null)[];
  readonly marker: string;
  readonly leaseRow: string;
}

/**
 * Keys wrapped under an older version of the tenant's key, and keys stored before tenant keys,
 * under a master key or none, are rewrapped under the version in force; a key forgotten or
 * replaced while it was being rewrapped is left as the store holds it. Once none is left the
 * rotation marks it complete for this set of versions and logs it, once until it rewraps again, so
 * an operator knows the older versions can be retired. While the mark stands nothing reads the key
 * table, but a pass once every `ROTATION_CHECK_INTERVAL_MS` across instances, which drops the mark
 * when it finds a key again. A rotation of the master key rewraps the tenant's record alone.
 */
export const createKeyRotation: CreateKeyRotationFunction = ({
  keys,
  indexKeys,
  checkpoints,
  tenantKeys,
  master,
  wrapping,
  reseal,
  clock,
  logger,
}) => {
  const leases = new Map<string, ReturnType<typeof createLease>>();
  const leaseOf = (row: string): ReturnType<typeof createLease> => {
    const known = leases.get(row);
    if (known !== undefined) return known;
    const lease = createLease({ checkpoints, row, clock, logger });
    leases.set(row, lease);
    return lease;
  };
  const currentSet = async (): Promise<RotationSet> => {
    const [{ kid, previous }, tenant] = await Promise.all([wrapping.kids(), tenantKeys.kids()]);
    // A set that names its own version among the older ones would rewrap it on every pass.
    const kids = previous.filter((each) => each !== kid);
    const set = digestOf(kid, kids);
    return {
      kid,
      versions: tenant.previous.filter((each) => each !== kid),
      kids,
      marker: `${ROTATED_PREFIX}${set}`,
      leaseRow: `${ROTATION_LEASE_PREFIX}${set}`,
    };
  };
  // Until when a pass reads nothing: the mark stands, or every key left is held.
  let completeUntil = Number.NEGATIVE_INFINITY;
  let restUntil = Number.NEGATIVE_INFINITY;
  // What `nextDueAt` last read, so a host that asks after every request reads the store once a
  // check interval at most; a pass that reads the table forgets it.
  let answer: Answer | null = null;
  const pause = createPause();
  let rewrappedAny = false;
  let masterReported = false;
  // Whether the store failed this pass a write no row can hold: the pass ends paused.
  let stalled = false;

  // A reseal says itself when the older versions can be retired.
  const report = async (set: RotationSet): Promise<void> => {
    if ((await reseal?.active()) === true) return;
    if (set.versions.length > 0) {
      logger.info(
        "no key is wrapped under an older version of the tenant's key any more; retire them",
        { kid: set.kid, previous: set.versions },
      );
    } else if (rewrappedAny) {
      logger.info("every key is wrapped under the tenant's key", { kid: set.kid });
    }
  };

  // The versions of the tenant's key, rewrapped under the master key in force: the one write a
  // rotation of the master key makes. Resolves whether none is left under a previous one. Only
  // this tenant's: whether another's is left, whose app may sleep, is the store's to say.
  const reportMaster = (): void => {
    if (masterReported || master.previous.length === 0) return;
    masterReported = true;
    logger.info(
      "this tenant's key is wrapped under the master key in force; remove the previous ones once bounda tenant-key rewrap-master, or the Worker's schedule, finds no tenant left under them",
      { kid: master.kid, previous: master.previous },
    );
  };
  const rewrapUnderMaster = async (): Promise<boolean> => {
    if (!tenantKeys.underPreviousMaster()) {
      reportMaster();
      return true;
    }
    try {
      await tenantKeys.rewrapUnderMaster();
      if (tenantKeys.underPreviousMaster()) return false;
      reportMaster();
      return true;
    } catch (error) {
      logger.error("the tenant's key could not be rewrapped under the master key", {
        kid: master.kid,
        error,
      });
      stalled = true;
      return false;
    }
  };

  // Of several instances finding it complete at once, the one that marks it first logs it.
  const complete = async (set: RotationSet, markedAt: number, at: number): Promise<void> => {
    completeUntil = at + ROTATION_CHECK_INTERVAL_MS;
    if (!(await checkpoints.compareAndSet(set.marker, markedAt, at))) return;
    if (markedAt === 0) await report(set);
    // The lease of another set lapsed at its position, as long ago as its mark was renewed.
    for (const { subscriber, position } of await checkpoints.list()) {
      if (
        (subscriber.startsWith(ROTATED_PREFIX) || subscriber.startsWith(ROTATION_LEASE_PREFIX)) &&
        subscriber !== set.marker &&
        subscriber !== set.leaseRow &&
        at - position >= ROTATION_MARK_EXPIRY_MS
      ) {
        await checkpoints.remove(subscriber);
      }
    }
  };

  // The database's keys, in force and previous, wrapped under anything but the version in force.
  const indexDue = async (set: RotationSet): Promise<readonly StoredPersonalKey[]> => {
    const keys = [(await indexKeys?.get()) ?? null, (await indexKeys?.previous()) ?? null];
    return keys.filter((key) => key !== null && set.kids.includes(key.kid)) as StoredPersonalKey[];
  };

  // Resolves whether the database's keys are wrapped under the version in force now; a failure is
  // logged and stalls the pass, and the rotation does not complete before they are rewrapped.
  const rewrapIndex = async (set: RotationSet): Promise<boolean> => {
    if (indexKeys === undefined) return true;
    let rewrapped = true;
    for (const due of await indexDue(set)) {
      try {
        rewrapped = (await indexKeys.rewrap(due, await wrapping.wrapped(due))) && rewrapped;
      } catch (error) {
        logger.error("the database's key could not be rewrapped", { kid: due.kid, error });
        stalled = true;
        return false;
      }
    }
    return rewrapped;
  };

  // Resolves whether the store kept the hold; one it could not keep pauses the rotation. A key a
  // reseal replaces is kept superseded rather than rewrapped. `moved` once a version put in force
  // since the pass began, as a reseal puts one, is what the key would go under: the reseal may have
  // begun after the pass read it did not, and replaces only what is under an older version, so the
  // next pass reads it again.
  const rewrap = async (
    row: PersonalKeyRow,
    at: number,
    { kid, replacing }: { readonly kid: string; readonly replacing: boolean },
  ): Promise<{ readonly rewrapped: boolean; readonly kept: boolean; readonly moved?: true }> => {
    try {
      if (replacing && reseal !== undefined) {
        return { rewrapped: await reseal.replace(row), kept: true };
      }
      const to = await wrapping.wrapped(row.key);
      if (to.kid !== kid) return { rewrapped: false, kept: true, moved: true };
      return { rewrapped: await keys.rewrap(row.person, row.key, to), kept: true };
    } catch (error) {
      logger.error(
        replacing ? "personal key could not be replaced" : "personal key could not be rewrapped",
        {
          personId: row.person,
          kid: row.key.kid,
          error,
        },
      );
    }
    try {
      await keys.hold(row.person, row.key, holdAfter({ held: row.hold, at, failed: true }));
      return { rewrapped: false, kept: true };
    } catch (error) {
      logger.error("personal key could not be held", {
        personId: row.person,
        kid: row.key.kid,
        error,
      });
      return { rewrapped: false, kept: false };
    }
  };

  const sweep = async (now: Date): Promise<number> => {
    const at = now.getTime();
    stalled = false;
    const mastered = await rewrapUnderMaster();
    const set = await currentSet();
    const lease = leaseOf(set.leaseRow);
    const markedAt = await checkpoints.get(set.marker);
    // A set never marked reads 0, as long ago as can be; a mark ahead of this clock, set by an
    // instance whose clock runs ahead, is checked rather than trusted for longer than it says.
    if (mastered && markedAt <= at && at - markedAt < ROTATION_CHECK_INTERVAL_MS) {
      completeUntil = markedAt + ROTATION_CHECK_INTERVAL_MS;
      return 0;
    }
    // While another instance holds the lease, its row is one read, the keys a batch.
    if (at < lease.heldElsewhereUntil() && !(await lease.take(at))) return 0;
    answer = null;
    const indexed = await rewrapIndex(set);
    const due = await keys.listWrappedUnder({
      kids: set.kids,
      releasedBy: now,
      limit: ROTATION_BATCH,
    });
    if (due.length === 0 && indexed && mastered) {
      const heldUntil = await keys.nextHoldEnd({ kids: set.kids, after: now });
      if (heldUntil === null) {
        await complete(set, markedAt, at);
        pause.resume();
        return 0;
      }
      restUntil = Math.min(heldUntil.getTime(), at + ROTATION_CHECK_INTERVAL_MS);
    }
    if (markedAt > 0) await checkpoints.remove(set.marker);
    const replacing = (await reseal?.replacing()) ?? false;
    let rewrapped = 0;
    let kept = true;
    for (const row of due) {
      // A lease that lapsed while this instance stalled was taken by another, which goes on.
      if (!(await lease.take(clock.now().getTime()))) break;
      const outcome = await rewrap(row, at, { kid: set.kid, replacing });
      if (outcome.moved) break;
      if (outcome.rewrapped) rewrapped += 1;
      kept &&= outcome.kept;
    }
    pause.settle(at, kept && !stalled);
    if (rewrapped > 0) rewrappedAny = true;
    return rewrapped;
  };

  const read = async (now: Date): Promise<Answer> => {
    const at = now.getTime();
    const later = at + ROTATION_CHECK_INTERVAL_MS;
    if (tenantKeys.underPreviousMaster()) return { next: at, until: later };
    const set = await currentSet();
    if ((await checkpoints.get(set.marker)) > 0) return { next: null, until: later };
    const [due] = await keys.listWrappedUnder({ kids: set.kids, releasedBy: now, limit: 1 });
    if (due !== undefined || (await indexDue(set)).length > 0) return { next: at, until: later };
    const heldUntil = (await keys.nextHoldEnd({ kids: set.kids, after: now }))?.getTime() ?? null;
    return { next: heldUntil, until: Math.min(heldUntil ?? later, later) };
  };

  const heldElsewhereUntil = (): number =>
    Math.max(
      Number.NEGATIVE_INFINITY,
      ...[...leases.values()].map((lease) => lease.heldElsewhereUntil()),
    );

  return {
    sweep: async (now) => {
      const at = now.getTime();
      if (pause.isPaused(at) || at < completeUntil || at < restUntil) return 0;
      try {
        return await sweep(now);
      } catch (error) {
        pause.pause(at);
        logger.error("personal keys to rewrap could not be listed", { error });
        return 0;
      }
    },
    // A mark that stands, however old, wakes nothing: the passes check it again as they run.
    nextDueAt: async () => {
      const now = clock.now();
      const at = now.getTime();
      if (at < completeUntil) return null;
      if (answer === null || at >= answer.until) answer = await read(now);
      return answer.next === null
        ? null
        : new Date(pause.notBefore(Math.max(answer.next, restUntil, heldElsewhereUntil())));
    },
    status: async () => {
      const set = await currentSet();
      const [pending, markedAt, index, resealed] = await Promise.all([
        keys.countWrappedUnder({ kids: set.kids }),
        checkpoints.get(set.marker),
        indexDue(set),
        reseal?.status() ?? null,
      ]);
      return {
        kid: set.kid,
        previous: set.versions,
        pending: pending + index.length,
        completeAt: markedAt === 0 ? null : new Date(markedAt).toISOString(),
        reseal: resealed,
      };
    },
    settled: async () => {
      const { kid, previous } = await tenantKeys.kids();
      const versions = previous.filter((each) => each !== kid);
      if (versions.length === 0) return true;
      const index = [(await indexKeys?.get())?.kid, (await indexKeys?.previous())?.kid];
      return (
        (await keys.countWrappedUnder({ kids: versions })) === 0 &&
        !versions.some((version) => index.includes(version))
      );
    },
    release: async () => {
      for (const lease of leases.values()) await lease.release();
    },
    restored: async (first) => {
      completeUntil = Number.NEGATIVE_INFINITY;
      restUntil = Number.NEGATIVE_INFINITY;
      answer = null;
      pause.resume();
      for (const lease of leases.values()) lease.reset();
      if (!first) return;
      await keys.releaseHolds().catch((error: unknown) => {
        logger.error("personal keys' holds could not be cleared", { error });
      });
    },
  };
};
