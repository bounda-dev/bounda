import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type { StoredDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import type { ResealedEvent } from "../../adapter/storage/event-store.ts";
import type { IdempotencyRecord, StoredAnswer } from "../../adapter/storage/idempotency-store.ts";
import type { PersonalKeyRow } from "../../adapter/storage/personal-key-store.ts";
import type { ScheduledCommand } from "../../adapter/storage/scheduler.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import { createLease, LEASE_MS } from "../shared/lease.ts";
import { isSealedAtRest } from "./at-rest.ts";
import { type DatabaseKey, epochNumber } from "./blind-index.ts";
import { isSealed } from "./crypto.ts";
import { createPause } from "./hold.ts";
import { createRekeying, type Rekeying } from "./rekeying.ts";
import { ROTATION_CHECK_INTERVAL_MS } from "./rotation.ts";
import type { TenantKeys } from "./tenant-keys.ts";
import { type PersonalKeyWrapping, UNWRAPPED_KEY_TTL_MS } from "./wrapped-keys.ts";

/**
 * The checkpoint rows of a reseal, named `<prefix><row>`: `started`, when it was asked for, in
 * milliseconds, which says one is under way; `step`, the step it is at, by its place in
 * `RESEAL_STEPS` from 1; `cursor`, where that step stands, or `answers-after:<key>`, the key the
 * answers are walked past; `switched`, when the database's key
 * was put in force; `answers-until`, when the last remembered answer filed under the database's
 * previous key expires; `completed`, when the last reseal ended; `lease`, until when the instance
 * resealing holds it.
 */
export const RESEAL_PREFIX = "personal-data:reseal:";

/**
 * How long a reseal waits, once every person's key is replaced and the database's key is too,
 * before it seals anything again: twice the key cache's time, within which every instance reads the
 * new keys and ends a unit of work that read the old ones.
 */
export const RESEAL_SWITCH_MS: number = 2 * UNWRAPPED_KEY_TTL_MS;

/**
 * The steps of a reseal, in order. `replacing`: each person's key is replaced by a new one under
 * the tenant's key in force, the old one kept, superseded, until the data under it is sealed
 * again, and the instances have taken the new keys; `events` to `answers`: what each store holds
 * is sealed again under the new keys, and the database's new key; `snapshots`: the snapshots go;
 * `read-models`: each read model holding personal data is rebuilt; `sealing`: what the scheduled
 * commands and dead letters still hold under an old key is sealed again, and the old keys are
 * destroyed, in one transaction; `expiring`: the database's previous key waits for the last answer
 * filed under it to expire.
 */
export const RESEAL_STEPS = [
  "replacing",
  "events",
  "scheduled",
  "letters",
  "failures",
  "answers",
  "snapshots",
  "read-models",
  "sealing",
  "expiring",
] as const;

export type ResealStep = (typeof RESEAL_STEPS)[number];

/**
 * Where the reseal of a tenant's personal data stands: the step under way, `complete` once none
 * is; when the one under way, or the last, was asked for and ended; and how many old keys are not
 * destroyed yet.
 */
export interface ResealStatus {
  readonly step: ResealStep | "complete";
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly superseded: number;
}

/**
 * The read models' part of a reseal: each one holding personal data rebuilt from a stream already
 * sealed again. `ready` once every one is.
 */
export interface ResealReadModels {
  advance(from: number): Promise<"progressed" | "ready">;
}

export interface PersonalDataReseal {
  /**
   * Starts a reseal, which the caller has checked none is under way: what `rotateTenantKey` does,
   * before it puts the tenant's new version in force.
   */
  begin(): Promise<void>;
  /**
   * After the tenant's new version is in force: puts the database's new key in force, keeping the
   * old one as the previous. A pass of the worker does it too.
   */
  switchDatabaseKey(): Promise<void>;
  /**
   * Whether a reseal is under way.
   */
  active(): Promise<boolean>;
  /**
   * Whether the keys a reseal superseded are still kept: the tenant's older versions, which wrap
   * them, cannot be retired yet.
   */
  holdsSuperseded(): Promise<boolean>;
  /**
   * Whether the rotation replaces the persons' keys it finds under an older version of the tenant's
   * key, rather than rewrapping them.
   */
  replacing(): Promise<boolean>;
  /**
   * Replaces a person's key by a new one under the tenant's key in force, keeping it superseded;
   * resolves whether the person still held it.
   */
  replace(row: PersonalKeyRow): Promise<boolean>;
  /**
   * Runs one unit of the step under way, and resolves to how many records it sealed again or
   * steps it took. Never rejects: a failure is logged and pauses the reseal, longer after each.
   */
  sweep(now: Date): Promise<number>;
  nextDueAt(): Promise<Date | null>;
  status(): Promise<ResealStatus | null>;
  release(): Promise<void>;
  /**
   * After the database went back to a copy, whose rows say where its reseal stood. Never rejects.
   */
  restored(): Promise<void>;
}

export interface CreatePersonalDataResealArgs {
  /**
   * The store as written.
   */
  readonly storage: Pick<
    Storage,
    | "transact"
    | "checkpointStore"
    | "eventStore"
    | "personalKeys"
    | "scheduler"
    | "deadLetterStore"
    | "idempotencyStore"
    | "snapshotStore"
    | "subscriberFailures"
    | "indexKeys"
  >;
  readonly wrapping: PersonalKeyWrapping;
  readonly tenantKeys: Pick<TenantKeys, "kids" | "rotate" | "refresh">;
  readonly databaseKey: DatabaseKey | null;
  readonly readModels: ResealReadModels;
  readonly batchSize: number;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreatePersonalDataResealFunction {
  (args: CreatePersonalDataResealArgs): PersonalDataReseal;
}

const ROWS = {
  started: `${RESEAL_PREFIX}started`,
  step: `${RESEAL_PREFIX}step`,
  cursor: `${RESEAL_PREFIX}cursor`,
  switched: `${RESEAL_PREFIX}switched`,
  answersUntil: `${RESEAL_PREFIX}answers-until`,
  completed: `${RESEAL_PREFIX}completed`,
  lease: `${RESEAL_PREFIX}lease`,
} as const;

const ANSWERS_AFTER = `${RESEAL_PREFIX}answers-after:`;

const stepOf = (stored: number): ResealStep =>
  RESEAL_STEPS[Math.min(Math.max(stored, 1), RESEAL_STEPS.length) - 1] as ResealStep;

const numberOf = (step: ResealStep): number => RESEAL_STEPS.indexOf(step) + 1;

const iso = (at: number): string | null => (at > 0 ? new Date(at).toISOString() : null);

/**
 * Replaces every key that seals a person's data, and the database's key, after a leak of every
 * level of keys at once, so that what was taken opens nothing written or kept from then on. The
 * tenant's key is rotated first; then the rotation replaces each person's key instead of
 * rewrapping it, and the database's key is replaced, the old ones kept until nothing needs them.
 * Once every instance has taken the new keys, each store is walked and what it holds sealed again,
 * in transactions that read what they rewrite, so a forgetting or a redaction that commits
 * meanwhile is never undone: a value under a key no store keeps any more, forgotten or redacted,
 * becomes `null` under a key no one keeps. The scheduled commands and dead letters, which the
 * runtime copies sealed values into, are walked again in the transaction that destroys the old
 * keys. One instance reseals at a time, under a lease; every step is resumed where it stood.
 */
export const createPersonalDataReseal: CreatePersonalDataResealFunction = ({
  storage,
  wrapping,
  tenantKeys,
  databaseKey,
  readModels,
  batchSize,
  clock,
  logger,
}) => {
  const { checkpointStore: checkpoints } = storage;
  const lease = createLease({ checkpoints, row: ROWS.lease, clock, logger });
  const pause = createPause();
  const outside = wrapping.over(storage.personalKeys);
  let idleUntil = Number.NEGATIVE_INFINITY;

  const startedAt = (): Promise<number> => checkpoints.get(ROWS.started);
  const active = async (): Promise<boolean> => (await startedAt()) > 0;
  const step = async (): Promise<ResealStep> => stepOf(await checkpoints.get(ROWS.step));
  const enter = async (next: ResealStep, cursor = 0): Promise<void> => {
    await checkpoints.set(ROWS.cursor, cursor);
    await checkpoints.set(ROWS.step, numberOf(next));
    logger.info("personal data reseal moved on", { step: next });
  };

  // The keys a value names, unwrapped ahead, outside any transaction, with those in their place.
  const warm = async (named: readonly (readonly [string, string])[]): Promise<void> => {
    const seen = new Set<string>();
    for (const [person, fingerprint] of named) {
      const id = JSON.stringify([person, fingerprint]);
      if (seen.has(id)) continue;
      seen.add(id);
      const key = await outside.opened(person, fingerprint);
      if (key?.successor !== undefined) await outside.opened(person, key.successor);
    }
  };
  const named = createRekeying(outside).named;

  const switchDatabaseKey = async (): Promise<void> => {
    const { indexKeys } = storage;
    if ((await indexKeys.previous()) === null) {
      const from = await indexKeys.get();
      if (from !== null) {
        await tenantKeys.refresh();
        const before = await epochNumber(from.fingerprint);
        let to = (await wrapping.generate()).stored;
        // Each table's epoch mark tells the two apart.
        while ((await epochNumber(to.fingerprint)) === before) {
          to = (await wrapping.generate()).stored;
        }
        await indexKeys.supersede(from, to, await wrapping.wrapped(from), clock.now());
      }
    }
    if ((await checkpoints.get(ROWS.switched)) === 0) {
      await checkpoints.set(ROWS.switched, clock.now().getTime());
    }
    await databaseKey?.refresh();
  };

  // The tenant's key was rotated after the reseal began, by the call that began it or, when that
  // stopped before it rotated, here.
  const rotatedSince = async (started: number, at: number): Promise<number | null> => {
    if (Date.parse((await tenantKeys.kids()).since) < started) await tenantKeys.refresh();
    const since = Date.parse((await tenantKeys.kids()).since);
    if (since >= started) return since;
    if (at - started < LEASE_MS) return null;
    await tenantKeys.rotate();
    return Date.parse((await tenantKeys.kids()).since);
  };

  const replacingDone = async (at: number): Promise<boolean> => {
    const since = await rotatedSince(await startedAt(), at);
    if (since === null) return false;
    let switched = await checkpoints.get(ROWS.switched);
    if (switched === 0) {
      await switchDatabaseKey();
      switched = await checkpoints.get(ROWS.switched);
    }
    if (at < Math.max(since, switched) + RESEAL_SWITCH_MS) return false;
    const { previous } = await wrapping.kids();
    return (await storage.personalKeys.countWrappedUnder({ kids: previous })) === 0;
  };

  const rewriteEvents = async (
    transaction: StorageTransaction,
    rekeying: Rekeying,
    events: readonly StoredEvent[],
  ): Promise<number> => {
    const resealed: ResealedEvent[] = [];
    for (const event of events) {
      const current = await transaction.eventStore.readOne({
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventId: event.id,
      });
      if (current === null) continue;
      const payload = await rekeying.payload(current.payload);
      if (payload !== current.payload) {
        resealed.push({ position: current.position, payload, person: current.person });
      }
    }
    if (resealed.length > 0) await transaction.eventStore.reseal(resealed);
    return resealed.length;
  };

  const rewriteScheduled = async (
    transaction: StorageTransaction,
    rekeying: Rekeying,
    entries: readonly ScheduledCommand[],
  ): Promise<number> => {
    let resealed = 0;
    for (const { dedupeKey } of entries) {
      const current = await transaction.scheduler.get(dedupeKey);
      if (current === null) continue;
      const from = current.command.payload;
      const payload = await rekeying.payload(from);
      const before = current.persons ?? [];
      const persons = await rekeying.persons(before);
      if (payload === from && persons === before) continue;
      await transaction.scheduler.reseal({ dedupeKey, from, payload, persons });
      resealed += 1;
    }
    return resealed;
  };

  const rewriteLetters = async (
    transaction: StorageTransaction,
    rekeying: Rekeying,
    letters: readonly StoredDeadLetter[],
  ): Promise<number> => {
    let resealed = 0;
    for (const { id } of letters) {
      const letter = await transaction.deadLetterStore.get(id);
      if (letter === null) continue;
      const errorMessage = await rekeying.text(letter.errorMessage);
      const errorStack =
        letter.errorStack === undefined ? undefined : await rekeying.text(letter.errorStack);
      const payload = await rekeying.payload(letter.payload);
      const persons =
        letter.persons === undefined ? undefined : await rekeying.persons(letter.persons);
      if (
        errorMessage === letter.errorMessage &&
        errorStack === letter.errorStack &&
        payload === letter.payload &&
        persons === letter.persons
      ) {
        continue;
      }
      await transaction.deadLetterStore.reseal(id, {
        person: letter.person,
        ...(letter.statePerson === undefined ? {} : { statePerson: letter.statePerson }),
        errorMessage,
        ...(errorStack === undefined ? {} : { errorStack }),
        ...(payload === undefined ? {} : { payload }),
        ...(persons === undefined ? {} : { persons }),
      });
      resealed += 1;
    }
    return resealed;
  };

  const rekeyingIn = (transaction: StorageTransaction): Rekeying =>
    createRekeying(wrapping.over(transaction.personalKeys));

  const lettersNamed = (letters: readonly StoredDeadLetter[]) =>
    letters.flatMap((letter) => [
      ...named(letter.errorMessage),
      ...(letter.errorStack === undefined ? [] : named(letter.errorStack)),
      ...named(letter.payload),
    ]);

  const events = async (cursor: number): Promise<number> => {
    const batch = await storage.eventStore.readAll({ afterPosition: cursor, limit: batchSize });
    const last = batch.at(-1);
    if (last === undefined) {
      await enter("scheduled");
      return 1;
    }
    const sealed = batch.filter((event) => named(event.payload).length > 0);
    await warm(sealed.flatMap((event) => named(event.payload)));
    const resealed =
      sealed.length === 0
        ? 0
        : await storage.transact((transaction) =>
            rewriteEvents(transaction, rekeyingIn(transaction), sealed),
          );
    await checkpoints.set(ROWS.cursor, last.position);
    return resealed + batch.length;
  };

  const scheduled = async (cursor: number): Promise<number> => {
    const batch = await storage.scheduler.list({ limit: batchSize, offset: cursor });
    if (batch.length === 0) {
      await enter("letters");
      return 1;
    }
    await warm(batch.flatMap((entry) => named(entry.command.payload)));
    const resealed = await storage.transact((transaction) =>
      rewriteScheduled(transaction, rekeyingIn(transaction), batch),
    );
    await checkpoints.set(ROWS.cursor, cursor + batch.length);
    return resealed + 1;
  };

  const letters = async (cursor: number): Promise<number> => {
    const batch = await storage.deadLetterStore.list({ limit: batchSize, offset: cursor });
    if (batch.length === 0) {
      await enter("failures");
      return 1;
    }
    await warm(lettersNamed(batch));
    const resealed = await storage.transact((transaction) =>
      rewriteLetters(transaction, rekeyingIn(transaction), batch),
    );
    await checkpoints.set(ROWS.cursor, cursor + batch.length);
    return resealed + 1;
  };

  // A subscriber's last failure is written outside any transaction; `reseal` writes it again only
  // while it is still on the same event.
  const failures = async (): Promise<number> => {
    const rekeying = createRekeying(outside);
    let resealed = 0;
    for (const failure of await storage.subscriberFailures.list()) {
      const errorMessage = await rekeying.text(failure.errorMessage);
      const errorStack =
        failure.errorStack === undefined ? undefined : await rekeying.text(failure.errorStack);
      if (errorMessage === failure.errorMessage && errorStack === failure.errorStack) continue;
      await storage.subscriberFailures.reseal(failure.subscriber, {
        eventId: failure.eventId,
        errorMessage,
        ...(errorStack === undefined ? {} : { errorStack }),
      });
      resealed += 1;
    }
    await enter("answers");
    return resealed + 1;
  };

  // An answer sealed at rest opens under the database's key in force or its previous one, which
  // does not say which: each is sealed again under the one in force.
  // `null` for one sealed under a key the database no longer holds, which no command reads again.
  const answerOf = async (
    rekeying: Rekeying,
    answer: StoredAnswer,
  ): Promise<StoredAnswer | null> => {
    if (isSealedAtRest(answer)) {
      if (databaseKey === null) return answer;
      let text: string;
      try {
        text = await databaseKey.atRest.open(answer);
      } catch {
        return null;
      }
      return databaseKey.atRest.seal(text);
    }
    return isSealed(answer) ? rekeying.sealed(answer) : answer;
  };

  const rewriteAnswers = async (
    transaction: StorageTransaction,
    rekeying: Rekeying,
    records: readonly IdempotencyRecord[],
    now: Date,
  ): Promise<number> => {
    let resealed = 0;
    for (const { key } of records) {
      const current = await transaction.idempotencyStore.get({ key, now });
      if (current === null || current.answer === null) continue;
      const answer = await answerOf(rekeying, current.answer);
      if (answer === null) {
        await transaction.idempotencyStore.erase({ key, now });
        resealed += 1;
        continue;
      }
      const persons = await rekeying.persons(current.persons);
      if (answer === current.answer && persons === current.persons) continue;
      await transaction.idempotencyStore.reseal({
        key,
        from: current.answer,
        answer,
        persons,
        now,
      });
      resealed += 1;
    }
    return resealed;
  };

  // Every record listed is filed under the database's key of its day: the previous key stays
  // until the last of them expires, so a command sent again with its key finds it.
  // The key the answers step stands past, named in a row of its own, since a checkpoint keeps a
  // number: a page by key misses no record the purge of expired ones shifts.
  const answersAfter = async (): Promise<readonly string[]> =>
    (await checkpoints.list())
      .map(({ subscriber }) => subscriber)
      .filter((row) => row.startsWith(ANSWERS_AFTER))
      .sort();
  const answers = async (now: Date): Promise<number> => {
    const rows = await answersAfter();
    const last = rows.at(-1);
    const after = last?.slice(ANSWERS_AFTER.length);
    const batch = await storage.idempotencyStore.list({
      now,
      limit: batchSize,
      ...(after === undefined ? {} : { after }),
    });
    const next = batch.at(-1);
    if (next === undefined) {
      for (const row of rows) await checkpoints.remove(row);
      await enter("snapshots");
      return 1;
    }
    const until = Math.max(...batch.map(({ expiresAt }) => Date.parse(expiresAt)));
    if (until > (await checkpoints.get(ROWS.answersUntil))) {
      await checkpoints.set(ROWS.answersUntil, until);
    }
    await warm(batch.flatMap(({ answer }) => (answer === null ? [] : named(answer))));
    const resealed = await storage.transact((transaction) =>
      rewriteAnswers(transaction, rekeyingIn(transaction), batch, now),
    );
    await checkpoints.set(`${ANSWERS_AFTER}${next.key}`, 1);
    for (const row of rows) await checkpoints.remove(row);
    return resealed + 1;
  };

  // A snapshot is a cache, sealed under the database's key of its day: each stream folds from its
  // events, sealed again, until it is written anew.
  const snapshots = async (): Promise<number> => {
    await storage.snapshotStore.clear();
    await enter("read-models", await storage.eventStore.lastPosition());
    return 1;
  };

  const rebuilt = async (from: number): Promise<number> => {
    if ((await readModels.advance(from)) === "progressed") return 1;
    await enter("sealing");
    return 1;
  };

  // Every scheduled command and dead letter is read inside the transaction that destroys the old
  // keys, which runs one at a time with any other: no copy of a sealed value made meanwhile is
  // left under one.
  const sealing = async (): Promise<number> => {
    const [entries, letters] = await Promise.all([
      storage.scheduler.list(),
      storage.deadLetterStore.list(),
    ]);
    await warm([
      ...entries.flatMap((entry) => named(entry.command.payload)),
      ...lettersNamed(letters),
    ]);
    const destroyed = await storage.transact(async (transaction) => {
      const rekeying = rekeyingIn(transaction);
      await rewriteScheduled(transaction, rekeying, await transaction.scheduler.list());
      await rewriteLetters(transaction, rekeying, await transaction.deadLetterStore.list());
      return wrapping.over(transaction.personalKeys).destroySuperseded();
    });
    logger.info("every person's key is replaced, and the old ones destroyed", { destroyed });
    await enter("expiring");
    return destroyed + 1;
  };

  const finish = async (at: number): Promise<void> => {
    await checkpoints.set(ROWS.completed, at);
    for (const row of [ROWS.step, ROWS.cursor, ROWS.switched, ROWS.answersUntil]) {
      await checkpoints.remove(row);
    }
    await checkpoints.remove(ROWS.started);
    logger.info("personal data resealed: every key that sealed it before is destroyed");
  };

  const expiring = async (at: number): Promise<number> => {
    const previous = await storage.indexKeys.previous();
    if (previous !== null) {
      if (at < (await checkpoints.get(ROWS.answersUntil))) return 0;
      await storage.indexKeys.dropPrevious(previous);
      await databaseKey?.refresh();
    }
    await finish(at);
    return 1;
  };

  const runStep = async (now: Date): Promise<number> => {
    const at = now.getTime();
    const current = await step();
    const cursor = await checkpoints.get(ROWS.cursor);
    switch (current) {
      case "replacing":
        if (!(await replacingDone(at))) return 0;
        await enter("events");
        return 1;
      case "events":
        return events(cursor);
      case "scheduled":
        return scheduled(cursor);
      case "letters":
        return letters(cursor);
      case "failures":
        return failures();
      case "answers":
        return answers(now);
      case "snapshots":
        return snapshots();
      case "read-models":
        return rebuilt(cursor);
      case "sealing":
        return sealing();
      case "expiring":
        return expiring(at);
    }
  };

  const dueAt = async (at: number): Promise<number> => {
    switch (await step()) {
      // Due at once while the database's key is not switched, its row reading 0.
      case "replacing":
        return Math.max(at, (await checkpoints.get(ROWS.switched)) + RESEAL_SWITCH_MS);
      // Without a previous key, nothing waits for the answers filed under it.
      case "expiring":
        return (await storage.indexKeys.previous()) === null
          ? at
          : Math.max(at, await checkpoints.get(ROWS.answersUntil));
      default:
        return at;
    }
  };

  return {
    begin: async () => {
      // Without its row, the step is the first.
      for (const row of [
        ROWS.step,
        ROWS.cursor,
        ROWS.switched,
        ROWS.answersUntil,
        ...(await answersAfter()),
      ]) {
        await checkpoints.remove(row);
      }
      await checkpoints.set(ROWS.started, clock.now().getTime());
      idleUntil = Number.NEGATIVE_INFINITY;
      logger.warn("personal data reseal started: every key that seals it will be replaced");
    },
    switchDatabaseKey,
    active,
    holdsSuperseded: async () => (await active()) && numberOf(await step()) < numberOf("expiring"),
    // A key an instance that has not read the rotation yet wraps under the older version is
    // replaced again on a later pass: the step ends only once none is left under one.
    replacing: async () => (await active()) && (await step()) === "replacing",
    replace: async (row) => {
      const generated = await wrapping.generate();
      const at = clock.now().toISOString();
      return storage.transact((transaction) =>
        transaction.personalKeys.supersede(row.person, row.key, { ...generated.stored, at }),
      );
    },
    sweep: async (now) => {
      const at = now.getTime();
      if (pause.isPaused(at)) return 0;
      try {
        if (!(await active())) return 0;
        if (at < lease.heldElsewhereUntil() || !(await lease.take(at))) return 0;
        const done = await runStep(now);
        pause.resume();
        return done;
      } catch (error) {
        pause.pause(at);
        logger.error("personal data reseal failed; it goes on at the next pass", { error });
        return 0;
      }
    },
    // Without a reseal, the row is read again once a check interval at most: a host that asks
    // after every request reads nothing more.
    nextDueAt: async () => {
      const at = clock.now().getTime();
      if (at < idleUntil) return null;
      if (!(await active())) {
        idleUntil = at + ROTATION_CHECK_INTERVAL_MS;
        return null;
      }
      return new Date(pause.notBefore(Math.max(await dueAt(at), lease.heldElsewhereUntil())));
    },
    status: async () => {
      const [started, completed] = await Promise.all([
        startedAt(),
        checkpoints.get(ROWS.completed),
      ]);
      if (started === 0 && completed === 0) return null;
      return {
        step: started === 0 ? "complete" : await step(),
        startedAt: iso(started),
        completedAt: started === 0 ? iso(completed) : null,
        superseded: await storage.personalKeys.countSuperseded(),
      };
    },
    release: () => lease.release(),
    restored: async () => {
      idleUntil = Number.NEGATIVE_INFINITY;
      pause.resume();
      lease.reset();
    },
  };
};
