import type { KeyRead } from "../adapter/storage/append-checks.ts";
import type { Hold } from "../adapter/storage/hold.ts";
import { isReleasedBy } from "../adapter/storage/hold.ts";
import {
  type DueKey,
  type HeldPersonalKey,
  type KeyedPerson,
  keyedPersonId,
  type PersonalKeyStore,
  type StoredPersonalKey,
} from "../adapter/storage/personal-key-store.ts";
import { createStoreEntries, type WithEntries } from "./entries.ts";
import { earliestHoldEnd } from "./holds.ts";

export interface KeptPersonalKeyStore extends WithEntries<PersonalKeyStore, string> {
  /**
   * Whether the person holds the key of that fingerprint in force, always for a `null` one,
   * answered at once: the memory snapshot store checks it in the same step as it writes, so no
   * forget runs between the two.
   */
  holds(held: KeyedPerson): boolean;
  /**
   * The key of that fingerprint as the person holds it, answered at once for the same reason.
   */
  keyOf(person: string, fingerprint: string): KeyRead | null;
}

export interface CreateKeptPersonalKeyStoreArgs {
  /**
   * Whether the category is restricted for the person, or they are as a whole: the sweeps leave
   * such a key alone.
   */
  readonly restricted: (person: string, category: string) => boolean;
  /**
   * The person's last activity recorded since their last forgetting as a whole, which a new key
   * starts from; `null` without one.
   */
  readonly lastActiveAt: (person: string) => string | null;
}

export interface CreateKeptPersonalKeyStoreFunction {
  (args: CreateKeptPersonalKeyStoreArgs): KeptPersonalKeyStore;
}

interface KeptPersonalKey extends StoredPersonalKey {
  readonly person: string;
  readonly category: string;
  readonly hold: Hold | null;
  readonly lastActiveAt: string | null;
  readonly retainedSince: string | null;
  readonly dueHold: Hold | null;
}

const stored = ({ key, fingerprint, kid }: KeptPersonalKey): StoredPersonalKey => ({
  key,
  fingerprint,
  kid,
});

const held = (kept: KeptPersonalKey): HeldPersonalKey => ({
  category: kept.category,
  key: stored(kept),
  retainedSince: kept.retainedSince,
  lastActiveAt: kept.lastActiveAt,
});

const isHeldBy = (
  kept: KeptPersonalKey | undefined,
  from: StoredPersonalKey,
): kept is KeptPersonalKey => kept?.key === from.key && kept.fingerprint === from.fingerprint;

// Entries are named as `keyedPersonId` names a person under a key.
const idOf = (person: string, fingerprint: string): string =>
  keyedPersonId({ person, fingerprint });

const dueKeyOf = (kept: KeptPersonalKey): DueKey => ({
  person: kept.person,
  category: kept.category,
  fingerprint: kept.fingerprint,
  lastActiveAt: kept.lastActiveAt ?? "",
  retainedSince: kept.retainedSince,
  hold: kept.dueHold,
});

// Persons, then fingerprints, are unique together, so no two compare equal.
const byPerson = (a: KeptPersonalKey, b: KeptPersonalKey): number =>
  a.person === b.person ? (a.fingerprint < b.fingerprint ? -1 : 1) : a.person < b.person ? -1 : 1;

export const createKeptPersonalKeyStore: CreateKeptPersonalKeyStoreFunction = ({
  restricted,
  lastActiveAt: lastActiveOf,
}) => {
  const keys = new Map<string, KeptPersonalKey>();
  const of = (person: string): KeptPersonalKey[] =>
    [...keys.values()].filter((kept) => kept.person === person);
  const inForce = (person: string, category: string): KeptPersonalKey | undefined =>
    of(person).find((kept) => kept.category === category && kept.retainedSince === null);
  const update = (kept: KeptPersonalKey, change: Partial<KeptPersonalKey>): void => {
    keys.set(idOf(kept.person, kept.fingerprint), { ...kept, ...change });
  };
  const due = (category: string, releasedBy: Date | undefined): KeptPersonalKey[] =>
    [...keys.values()].filter(
      (kept) =>
        kept.category === category &&
        kept.lastActiveAt !== null &&
        !restricted(kept.person, kept.category) &&
        isReleasedBy(kept.dueHold, releasedBy),
    );
  const retainedOutside = (except: readonly string[]): KeptPersonalKey[] =>
    [...keys.values()].filter(
      (kept) =>
        kept.retainedSince !== null &&
        !except.includes(kept.category) &&
        !restricted(kept.person, kept.category),
    );
  return {
    holds: ({ person, fingerprint }) =>
      fingerprint === null || keys.get(idOf(person, fingerprint))?.retainedSince === null,
    keyOf: (person, fingerprint) => {
      const kept = keys.get(idOf(person, fingerprint));
      if (kept === undefined) return null;
      return { state: kept.retainedSince === null ? "held" : "retained", category: kept.category };
    },
    store: {
      get: async (person, category) => {
        const kept = inForce(person, category);
        return kept === undefined ? null : stored(kept);
      },
      find: async (person, fingerprint) => {
        const kept = keys.get(idOf(person, fingerprint));
        return kept === undefined ? null : held(kept);
      },
      list: async (person) => of(person).sort(byPerson).map(held),
      add: async (person, category, key) => {
        const existing = inForce(person, category);
        if (existing !== undefined) return stored(existing);
        const kept: KeptPersonalKey = {
          person,
          category,
          key: key.key,
          fingerprint: key.fingerprint,
          kid: key.kid,
          hold: null,
          lastActiveAt: lastActiveOf(person),
          retainedSince: null,
          dueHold: null,
        };
        keys.set(idOf(person, key.fingerprint), kept);
        return stored(kept);
      },
      remove: async (person, fingerprint) => keys.delete(idOf(person, fingerprint)),
      retain: async (person, fingerprint, { since, lastActiveAt }) => {
        const kept = keys.get(idOf(person, fingerprint));
        if (kept === undefined || kept.retainedSince !== null) return false;
        update(kept, { retainedSince: since, lastActiveAt, dueHold: null });
        return true;
      },
      touch: async (person, lastActiveAt) => {
        for (const kept of of(person)) {
          if (kept.retainedSince !== null) continue;
          if (kept.lastActiveAt !== null && kept.lastActiveAt >= lastActiveAt) continue;
          update(kept, { lastActiveAt, dueHold: null });
        }
      },
      listDue: async ({ category, activeBefore, releasedBy, limit }) => {
        const before = activeBefore?.toISOString();
        return due(category, releasedBy)
          .filter((kept) => before === undefined || (kept.lastActiveAt ?? "") <= before)
          .sort((a, b) =>
            a.lastActiveAt === b.lastActiveAt
              ? byPerson(a, b)
              : (a.lastActiveAt ?? "") < (b.lastActiveAt ?? "")
                ? -1
                : 1,
          )
          .slice(0, limit)
          .map(dueKeyOf);
      },
      holdDue: async (person, fingerprint, lastActiveAt, hold) => {
        const kept = keys.get(idOf(person, fingerprint));
        if (kept?.lastActiveAt === lastActiveAt) update(kept, { dueHold: hold });
      },
      nextDueHoldEnd: async ({ category, after }) =>
        earliestHoldEnd(
          due(category, undefined).map(({ dueHold }) => dueHold),
          after,
        ),
      listRetained: async ({ except, releasedBy, limit }) =>
        retainedOutside(except)
          .filter((kept) => isReleasedBy(kept.dueHold, releasedBy))
          .sort((a, b) =>
            a.retainedSince === b.retainedSince
              ? byPerson(a, b)
              : (a.retainedSince ?? "") < (b.retainedSince ?? "")
                ? -1
                : 1,
          )
          .slice(0, limit)
          .map(dueKeyOf),
      nextRetainedHoldEnd: async ({ except, after }) =>
        earliestHoldEnd(
          retainedOutside(except).map(({ dueHold }) => dueHold),
          after,
        ),
      listWrappedUnder: async ({ kids, releasedBy, limit }) =>
        [...keys.values()]
          .filter((kept) => kids.includes(kept.kid))
          .filter(({ hold }) => isReleasedBy(hold, releasedBy))
          .sort(byPerson)
          .slice(0, limit)
          .map((kept) => ({
            person: kept.person,
            category: kept.category,
            key: stored(kept),
            hold: kept.hold,
          })),
      rewrap: async (person, from, to) => {
        const kept = keys.get(idOf(person, from.fingerprint));
        if (!isHeldBy(kept, from)) return false;
        update(kept, { key: to.key, kid: to.kid, hold: null });
        return true;
      },
      hold: async (person, from, hold) => {
        const kept = keys.get(idOf(person, from.fingerprint));
        if (isHeldBy(kept, from)) update(kept, { hold });
      },
      nextHoldEnd: async ({ kids, after }) =>
        earliestHoldEnd(
          [...keys.values()].filter((kept) => kids.includes(kept.kid)).map(({ hold }) => hold),
          after,
        ),
      countWrappedUnder: async ({ kids }) =>
        [...keys.values()].filter((key) => kids.includes(key.kid)).length,
      releaseHolds: async () => {
        const held = [...keys.values()].filter(({ hold }) => hold !== null);
        for (const kept of held) update(kept, { hold: null });
        return held.length;
      },
      countDue: async ({ category, activeBefore }) => {
        const before = activeBefore?.toISOString();
        return due(category, undefined).filter(
          (kept) => before === undefined || (kept.lastActiveAt ?? "") <= before,
        ).length;
      },
      countRetained: async ({ except }) => retainedOutside(except).length,
      releaseDueHolds: async () => {
        const held = [...keys.values()].filter(({ dueHold }) => dueHold !== null);
        for (const kept of held) update(kept, { dueHold: null });
        return held.length;
      },
    },
    entries: createStoreEntries(keys, (id: string) => id),
  };
};
