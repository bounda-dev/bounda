import type { Storage } from "../../adapter/adapter.ts";
import type { Hold } from "../../adapter/storage/hold.ts";
import { isReleasedBy } from "../../adapter/storage/hold.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { errorDetails } from "../shared/retry.ts";
import { ATTRIBUTES, traced } from "../telemetry.ts";
import { createPause, holdAfter } from "./hold.ts";
import {
  addSealed,
  createResealBatches,
  NOTHING_SEALED,
  type ResealBatches,
  type Sealed,
} from "./reseal-batches.ts";
import type { PersonalKeyWrapping } from "./wrapped-keys.ts";

/**
 * The checkpoint rows of the backfill, named `<prefix><marks>:<row>` after the fingerprint of the
 * marks it seals for: `started`, when the first pass under them ran, in milliseconds; `position`,
 * the global position the walk has sealed through; `stores`, when it last went through the
 * scheduled commands and dead letters; `lease`, until when the instance walking holds the walk;
 * `held-until` and `attempts`, the hold of a walk that failed. Marks that change start them all
 * again.
 */
export const BACKFILL_PREFIX = "personal-data:backfill:";

// How long a walk that reached the head of the stream rests before it reads what came after: an
// instance still writing with older marks, as in a rolling deploy, has its events sealed this
// late.
export const BACKFILL_FOLLOW_INTERVAL_MS = 60_000;

// How long the instance walking holds the walk without renewing it, which it does on every pass.
export const BACKFILL_LEASE_MS: number = 2 * BACKFILL_FOLLOW_INTERVAL_MS;

// How long the lease of other marks must have lapsed before their rows are removed: marks some
// instance still runs renew theirs at least every lease.
export const BACKFILL_EXPIRY_MS: number = 10 * BACKFILL_FOLLOW_INTERVAL_MS;

export interface PersonalDataBackfillStatus {
  readonly position: number;
  readonly caughtUp: boolean;
}

export interface PersonalDataBackfill {
  /**
   * Seals a batch of the stream past the walk's position, or, once the walk has reached the head
   * for the first time, every scheduled command and dead letter, and resolves to how many events
   * it walked past and records it resealed. Never rejects: a failure is logged and holds the walk,
   * longer after each failure in a row of any instance.
   */
  sweep(now: Date): Promise<number>;
  /**
   * Now until the walk has caught up once, unless a lease or a hold keeps it later; `null` from
   * then on, since what comes after is read on the passes the worker runs anyway.
   */
  nextDueAt(): Promise<Date | null>;
  /**
   * Where the walk stands, as the rows say: the global position it sealed through, and whether
   * it has reached the head of the stream after going through the scheduled commands and dead
   * letters.
   */
  status(head: number): Promise<PersonalDataBackfillStatus>;
  /**
   * Gives the lease back when this instance holds it, so another walks at once instead of waiting
   * for it to lapse. Never rejects.
   */
  release(): Promise<void>;
}

export interface CreatePersonalDataBackfillArgs {
  /**
   * The store as written: the walk reads and reseals what the store holds.
   */
  readonly storage: Pick<
    Storage,
    "transact" | "checkpointStore" | "eventStore" | "personalKeys" | "scheduler" | "deadLetterStore"
  >;
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "byName">;
  readonly wrapping: PersonalKeyWrapping;
  /**
   * The fingerprint of the marks, as `marksFingerprint` names them.
   */
  readonly marks: string;
  readonly batchSize: number;
  /**
   * Whether a retention is configured: a person an event names only once it is resealed has
   * their activity recorded, so the retention knows them.
   */
  readonly recordsActivity: boolean;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreatePersonalDataBackfillFunction {
  (args: CreatePersonalDataBackfillArgs): PersonalDataBackfill;
}

const rowsOf = (marks: string) => {
  const row = (name: string): string => `${BACKFILL_PREFIX}${marks}:${name}`;
  return {
    started: row("started"),
    position: row("position"),
    stores: row("stores"),
    lease: row("lease"),
    heldUntil: row("held-until"),
    attempts: row("attempts"),
  };
};

/**
 * Walks the global stream from its first event and seals in place what each event holds in the
 * clear of a field its schema marks now, under the key of the person the marks name, who becomes
 * the event's `person`; then does the same for the payloads of scheduled commands and dead
 * letters, and for the error text of letters whose work names someone now. What a person forgot
 * before it was written is sealed under a key no store keeps, as their forgetting would have left
 * it. The walk keeps its position per set of marks, so marks that change walk again from the
 * start, and marks that do not never walk twice; past the head it keeps reading what comes after,
 * every `BACKFILL_FOLLOW_INTERVAL_MS`, and goes through the stores again after resealing any of
 * it. One instance walks at a time, under a lease; a failure holds the walk for every instance,
 * longer after each in a row. What a batch holds of one person is resealed in one transaction,
 * which a store runs one at a time with any `forget`, so their forgetting either came before, and
 * it seals what they had then under a discarded key, or after, and removes the key it sealed with.
 */
export const createPersonalDataBackfill: CreatePersonalDataBackfillFunction = ({
  storage,
  aggregates,
  processes,
  wrapping,
  marks,
  batchSize,
  recordsActivity,
  clock,
  logger,
}) => {
  const { checkpointStore } = storage;
  const rows = rowsOf(marks);
  const pause = createPause();
  let restUntil = Number.NEGATIVE_INFINITY;
  // Until when another instance's lease keeps the walk, for `nextDueAt`: the passes read the lease
  // again, so a lease given back is taken at once.
  let leasedUntil = Number.NEGATIVE_INFINITY;
  let lease: number | null = null;
  let caughtUp = false;
  // This instance's tally since it started, for the line it logs when the walk catches up.
  let tally = { events: 0, discarded: 0, unsealable: 0, scheduledCommands: 0, deadLetters: 0 };

  const reseal: ResealBatches = createResealBatches({
    storage,
    aggregates,
    processes,
    wrapping,
    recordsActivity,
  });

  // Pages by offset, which resealing never moves: it changes no row's place in the order.
  const sealPages = async <Row>(
    list: (page: { readonly limit: number; readonly offset: number }) => Promise<readonly Row[]>,
    sealPage: (rows: readonly Row[]) => Promise<Sealed>,
  ): Promise<Sealed> => {
    let sealed = NOTHING_SEALED;
    for (let offset = 0; ; offset += batchSize) {
      const page = await list({ limit: batchSize, offset });
      sealed = addSealed(sealed, await sealPage(page));
      if (page.length < batchSize) return sealed;
    }
  };

  // No row reads as a hold that ended long ago, after no failure.
  const storedHold = async (): Promise<Hold> => {
    const [until, attempts] = await Promise.all([
      checkpointStore.get(rows.heldUntil),
      checkpointStore.get(rows.attempts),
    ]);
    return { until: new Date(until).toISOString(), attempts };
  };

  // A hold still running was set by another instance failing in the same round: this failure
  // waits for it rather than counting once more.
  const hold = async (at: number): Promise<void> => {
    const held = await storedHold();
    if (!isReleasedBy(held, new Date(at))) {
      restUntil = Date.parse(held.until);
      return;
    }
    const next = holdAfter({ held, at, failed: true });
    restUntil = Date.parse(next.until);
    await checkpointStore.set(rows.attempts, next.attempts);
    await checkpointStore.set(rows.heldUntil, restUntil);
  };

  const releaseHold = async (): Promise<void> => {
    if ((await checkpointStore.get(rows.attempts)) === 0) return;
    await checkpointStore.remove(rows.attempts);
    await checkpointStore.remove(rows.heldUntil);
  };

  // Resolves whether this instance walks: it holds the lease, renewed once half of it is spent, or
  // took it once it lapsed. A lease more than a lease ahead was written by a clock that runs ahead,
  // and is taken.
  const takeLease = async (at: number): Promise<boolean> => {
    const held = await checkpointStore.get(rows.lease);
    if (held === lease && held - at > BACKFILL_LEASE_MS / 2) return true;
    if (held !== lease && held > at && held <= at + BACKFILL_LEASE_MS) {
      lease = null;
      leasedUntil = held;
      return false;
    }
    const until = at + BACKFILL_LEASE_MS;
    if (!(await checkpointStore.compareAndSet(rows.lease, held, until))) {
      lease = null;
      return false;
    }
    lease = until;
    leasedUntil = Number.NEGATIVE_INFINITY;
    return true;
  };

  // The rows of other marks whose lease lapsed long ago: no instance runs those marks any more.
  const removeStale = async (at: number): Promise<void> => {
    const others = new Map<string, { lease: number; rows: string[] }>();
    for (const { subscriber, position } of await checkpointStore.list()) {
      if (!subscriber.startsWith(BACKFILL_PREFIX)) continue;
      const [owner = "", name] = subscriber.slice(BACKFILL_PREFIX.length).split(":");
      if (owner === marks) continue;
      const known = others.get(owner) ?? { lease: 0, rows: [] };
      others.set(owner, {
        lease: name === "lease" ? position : known.lease,
        rows: [...known.rows, subscriber],
      });
    }
    for (const other of others.values()) {
      if (at - other.lease < BACKFILL_EXPIRY_MS) continue;
      for (const row of other.rows) await checkpointStore.remove(row);
    }
  };

  const report = (): void => {
    logger.info("personal data written before its marks is sealed", { marks, ...tally });
    tally = { events: 0, discarded: 0, unsealable: 0, scheduledCommands: 0, deadLetters: 0 };
  };

  const warnOf = (sealed: Sealed, from: number, through: number): void => {
    if (sealed.unsealable > 0) {
      logger.warn("personal data written before its marks names no person and stays in the clear", {
        events: sealed.unsealable,
        eventTypes: [...sealed.unsealableTypes],
        afterPosition: from,
        throughPosition: through,
      });
    }
    if (sealed.discarded > 0) {
      logger.warn(
        "personal data of persons forgotten before it was marked is sealed for good; rebuild the read models that project it",
        {
          events: sealed.discarded,
          eventTypes: [...sealed.discardedTypes],
          afterPosition: from,
          throughPosition: through,
        },
      );
    }
  };

  // Resolves to how many events it walked past, `moved` when another instance moved the position
  // first.
  const walk = async (position: number): Promise<number | "moved"> => {
    const events = await storage.eventStore.readAll({ afterPosition: position, limit: batchSize });
    const last = events.at(-1)?.position;
    if (last === undefined) return 0;
    const sealed = await traced({
      name: "bounda.backfill",
      attributes: {
        [ATTRIBUTES.afterPosition]: position,
        [ATTRIBUTES.eventCount]: events.length,
      },
      run: () => reseal.events(events),
    });
    if (!(await checkpointStore.compareAndSet(rows.position, position, last))) return "moved";
    warnOf(sealed, position, last);
    tally = {
      ...tally,
      events: tally.events + sealed.resealed,
      discarded: tally.discarded + sealed.discarded,
      unsealable: tally.unsealable + sealed.unsealable,
    };
    if (sealed.resealed > 0) {
      logger.debug("personal data written before its marks sealed", {
        events: sealed.resealed,
        afterPosition: position,
        throughPosition: last,
      });
      // An event in the clear past the stores' pass was written with older marks, which may have
      // stored commands and letters in the clear too.
      if ((await checkpointStore.get(rows.stores)) > 0) await checkpointStore.remove(rows.stores);
    }
    return events.length;
  };

  const sealStores = async (at: number, started: number): Promise<number> => {
    const commands = await sealPages(
      (page) => storage.scheduler.list(page),
      (entries) => reseal.commands(entries),
    );
    const letters = await sealPages(
      (page) => storage.deadLetterStore.list(page),
      (page) => reseal.letters(page, started),
    );
    tally = {
      ...tally,
      discarded: tally.discarded + commands.discarded + letters.discarded,
      unsealable: tally.unsealable + commands.unsealable + letters.unsealable,
      scheduledCommands: tally.scheduledCommands + commands.resealed,
      deadLetters: tally.deadLetters + letters.resealed,
    };
    if (commands.unsealable > 0) {
      logger.warn(
        "scheduled commands stored before their marks name no person and stay in the clear",
        {
          scheduledCommands: commands.unsealable,
          commandTypes: [...commands.unsealableTypes],
        },
      );
    }
    await checkpointStore.set(rows.stores, at);
    return commands.resealed + letters.resealed;
  };

  const status = async (head: number): Promise<PersonalDataBackfillStatus> => {
    const [position, stores] = await Promise.all([
      checkpointStore.get(rows.position),
      checkpointStore.get(rows.stores),
    ]);
    return { position, caughtUp: stores > 0 && position >= head };
  };

  const pass = async (now: Date): Promise<number> => {
    const at = now.getTime();
    const heldUntil = await checkpointStore.get(rows.heldUntil);
    if (heldUntil > at) {
      restUntil = heldUntil;
      return 0;
    }
    if (!(await takeLease(at))) return 0;
    let started = await checkpointStore.get(rows.started);
    if (started === 0) {
      await checkpointStore.compareAndSet(rows.started, 0, at);
      started = await checkpointStore.get(rows.started);
    }
    const position = await checkpointStore.get(rows.position);
    const walked = await walk(position);
    if (walked === "moved") return 0;
    if (walked >= batchSize) return walked;
    let stored = 0;
    if ((await checkpointStore.get(rows.stores)) === 0) {
      stored = await sealStores(at, started);
      report();
    }
    caughtUp = true;
    restUntil = at + BACKFILL_FOLLOW_INTERVAL_MS;
    await releaseHold();
    await removeStale(at);
    return walked + stored;
  };

  return {
    sweep: async (now) => {
      const at = now.getTime();
      if (pause.isPaused(at) || at < restUntil) return 0;
      try {
        const done = await pass(now);
        pause.resume();
        return done;
      } catch (error) {
        logger.error(
          "personal data written before its marks could not be sealed",
          errorDetails(error),
        );
        await hold(at).catch((holdError: unknown) => {
          pause.pause(at);
          logger.error("personal data backfill could not be held", errorDetails(holdError));
        });
        return 0;
      }
    },
    // A walk that caught up once, here, on another instance or before a restart, wakes nothing:
    // what comes after is written sealed, but by an instance on older marks, which the passes
    // the worker runs anyway follow.
    nextDueAt: async () => {
      if (caughtUp) return null;
      caughtUp = (await checkpointStore.get(rows.stores)) > 0;
      if (caughtUp) return null;
      return new Date(pause.notBefore(Math.max(clock.now().getTime(), restUntil, leasedUntil)));
    },
    status,
    // Lapsed now rather than removed, so the rows of these marks stay while instances may run them.
    release: async () => {
      if (lease === null) return;
      const held = lease;
      lease = null;
      const lapsed = Math.min(held, clock.now().getTime());
      await checkpointStore.compareAndSet(rows.lease, held, lapsed).catch((error: unknown) => {
        logger.error("personal data backfill could not give its lease back", errorDetails(error));
      });
    },
  };
};
