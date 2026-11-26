import { describe, expect, it } from "vitest";
import type {
  ForgetLedgerEntry,
  LedgerDisclosure,
  LedgerRestriction,
} from "../../adapter/storage/forget-ledger.ts";
import type { StoredRestriction } from "../../adapter/storage/person-store.ts";
import type { HeldPersonalKey } from "../../adapter/storage/personal-key-store.ts";
import type { StoredDisclosure } from "../../adapter/storage/recipient-store.ts";
import type { TenantFence } from "../../adapter/storage/tenant-fence.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createMemoryForgetLedgers } from "../../memory/forget-ledger.ts";
import {
  BOUNDA_AGGREGATE,
  PROCESSING_RESTRICTED_EVENT,
  PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT,
  PROCESSING_RESTRICTION_LIFTED_EVENT,
} from "../../modules/bounda-events.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { RESTORE_GENERATION } from "../shared/restores.ts";
import { buildPersonalCategories } from "./categories.ts";
import {
  type AppliedStorage,
  type PruneAsAppliedArgs,
  pruneAsApplied,
  type ReconciliationRules,
  strandedEntries,
} from "./ledger-prune.ts";
import { FORGET_LEDGER_CURSOR, FORGET_LEDGER_REREAD_MS } from "./reconciliation.ts";

const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-11-25T12:00:00.000Z");
const KEEP_FOR_MS = 30 * DAY;
const CUTOFF = new Date(NOW.getTime() - KEEP_FOR_MS).toISOString();

// `days` before the cutoff, so a negative number is younger than `keepFor`.
const at = (days: number): string =>
  new Date(NOW.getTime() - KEEP_FOR_MS - days * DAY).toISOString();

const entry = (
  id: string,
  days: number,
  extra: Partial<ForgetLedgerEntry> = {},
): ForgetLedgerEntry => ({
  personId: `p-${id}`,
  categories: null,
  eventId: `e-${id}`,
  forgottenAt: at(days),
  reason: "requested",
  ...extra,
});

const DISCLOSURE: LedgerDisclosure = {
  port: "mailer",
  recipient: "Acme Mail",
  kind: "processor",
  country: "DE",
  safeguard: null,
  category: "contact",
};

const OPEN: TenantFence = { state: "open" };
const FORGOTTEN: TenantFence = { state: "forgotten", tenant: "acme", since: at(40) };

// What the app decides with: `contact`, which an objection reaches and which is forgotten after
// 30 days idle, and a customer's registration, whose email is personal.
const RULES: ReconciliationRules = {
  categories: buildPersonalCategories({
    module: {
      automatedDecisions: {},
      categories: {
        contact: {
          basis: "legitimate-interests",
          retention: "30d",
          purposes: ["Reach the person"],
          sources: ["data-subject"],
        },
      },
    },
    retention: null,
  }),
  aggregates: {
    byName: {
      customer: {
        eventsByType: {
          CustomerRegistered: {
            personal: { person: "customerId", fields: ["email"], categories: {} },
          },
        },
      },
    },
    commandsByType: {},
  } as unknown as AggregatesRuntime,
  processes: { byName: {} },
  batchSize: 100,
};

const prune = (
  args: Omit<PruneAsAppliedArgs, "rules" | "followed"> & Partial<PruneAsAppliedArgs>,
) => pruneAsApplied({ rules: () => RULES, followed: true, ...args });

interface DatabaseArgs {
  // The events of the persons' `bounda` aggregate it holds, by id.
  readonly held?: readonly string[];
  readonly cursor?: number;
  readonly fence?: TenantFence;
  readonly disclosures?: readonly StoredDisclosure[];
  readonly events?: readonly StoredEvent[];
  // The keys `p-1` holds.
  readonly keys?: readonly HeldPersonalKey[];
  readonly generation?: number;
  readonly position?: number;
  // The events of the app's aggregates it holds.
  readonly stored?: readonly StoredEvent[];
  // When `p-1` was last active as the retention recorded it, and whether it is restricted.
  readonly person?: { readonly lastActiveAt: string; readonly restrictedSince?: string };
  // The rows of `p-1`'s restrictions.
  readonly restrictions?: readonly StoredRestriction[];
}

interface Stream {
  readonly aggregateType: string;
  readonly aggregateId: string;
}

const database = ({
  held = [],
  cursor = 0,
  fence = OPEN,
  disclosures = [],
  events = [],
  keys = [],
  generation = 0,
  position = 0,
  stored = [],
  person,
  restrictions = [],
}: DatabaseArgs = {}): AppliedStorage =>
  ({
    checkpointStore: {
      get: async (name: string) =>
        name === FORGET_LEDGER_CURSOR ? cursor : name === RESTORE_GENERATION ? generation : 0,
    },
    eventStore: {
      // Each entry's event is the person's of the same suffix: `e-1` is `p-1`'s.
      readOne: async ({ aggregateType, aggregateId, eventId }: Stream & { eventId: string }) =>
        aggregateType === BOUNDA_AGGREGATE
          ? aggregateId === eventId.replace("e-", "p-") && held.includes(eventId)
            ? ({ id: eventId } as StoredEvent)
            : null
          : (stored.find(
              (event) =>
                event.aggregateType === aggregateType &&
                event.aggregateId === aggregateId &&
                event.id === eventId,
            ) ?? null),
      readByPerson: async () => [],
      load: async ({ aggregateType, aggregateId }: Stream) => {
        const own = aggregateType === BOUNDA_AGGREGATE && aggregateId === "p-1" ? events : [];
        return { events: own, version: own.length };
      },
      lastPosition: async () => position,
    },
    personalKeys: {
      list: async (asked: string) => (asked === "p-1" ? keys : []),
      find: async (asked: string, fingerprint: string) =>
        asked === "p-1" ? (keys.find(({ key }) => key.fingerprint === fingerprint) ?? null) : null,
    },
    persons: {
      get: async (asked: string) =>
        asked === "p-1" && person !== undefined
          ? {
              person: asked,
              lastActiveAt: person.lastActiveAt,
              restrictedSince: person.restrictedSince ?? null,
              forgottenAt: null,
            }
          : null,
      restrictions: async (asked: string) => (asked === "p-1" ? restrictions : []),
    },
    recipients: {
      disclosures: async (person: string) => disclosures.filter((held) => held.person === person),
    },
    fence: { read: async () => fence, set: async (asked: TenantFence) => asked },
  }) as unknown as AppliedStorage;

const ledgerWith = async (entries: readonly ForgetLedgerEntry[], fence: TenantFence = OPEN) => {
  const ledger = createMemoryForgetLedgers().ledgerOf("acme");
  await ledger.append(entries);
  if (fence.state !== "open") await ledger.fence.set(fence);
  const { prune } = ledger;
  if (prune === undefined) throw new Error("the memory ledger prunes");
  return { ...ledger, prune };
};

const kept = async (ledger: Awaited<ReturnType<typeof ledgerWith>>): Promise<readonly string[]> =>
  (await ledger.read({ limit: 100 })).map(({ eventId }) => eventId);

// A tenant its tenant key store does not know forgotten.
const unknown = async (): Promise<boolean> => false;

const opening = (storage: AppliedStorage | null) => {
  const opened = { times: 0 };
  return {
    opened,
    withStorage: async <T>(work: (storage: AppliedStorage | null) => Promise<T>): Promise<T> => {
      opened.times += 1;
      return work(storage);
    },
  };
};

describe("pruning a forget ledger with no app running", () => {
  it("removes the entries older than keepFor the database holds, and keeps the younger ones", async () => {
    const ledger = await ledgerWith([entry("1", 3), entry("2", 1), entry("3", -1)]);
    const { withStorage } = opening(database({ held: ["e-1", "e-2", "e-3"] }));
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
      }),
    ).toEqual({
      before: CUTOFF,
      unapplied: false,
    });
    expect(await kept(ledger)).toEqual(["e-3"]);
  });

  it("keeps, from the oldest entry the database lacks on, what its reconciliation has yet to read", async () => {
    const ledger = await ledgerWith([entry("1", 5), entry("2", 3), entry("3", 2), entry("4", -1)]);
    const { withStorage } = opening(database({ held: ["e-1", "e-3", "e-4"] }));
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
      }),
    ).toEqual({
      before: at(3),
      unapplied: true,
    });
    expect(await kept(ledger)).toEqual(["e-2", "e-3", "e-4"]);
  });

  it("removes what the reconciliation will not read again, past its cursor less what it reads again, held or not", async () => {
    const cursor = Date.parse(at(2));
    const ledger = await ledgerWith([
      entry("1", 5),
      // Read again, and lacked: kept.
      entry("2", 2 + (FORGET_LEDGER_REREAD_MS - 1) / DAY),
      entry("3", -1),
    ]);
    const { withStorage } = opening(database({ cursor }));
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
      }),
    ).toEqual({
      before: at(2 + (FORGET_LEDGER_REREAD_MS - 1) / DAY),
      unapplied: true,
    });
    expect(await kept(ledger)).toEqual(["e-2", "e-3"]);
  });

  it("leaves an entry exactly keepFor old, which the database lacks, in a ledger it follows or not", async () => {
    for (const followed of [true, false]) {
      const ledger = await ledgerWith([entry("1", 1), entry("2", 0)]);
      const { withStorage } = opening(database({ held: ["e-1"] }));
      expect(
        await prune({
          ledger,
          forgotten: unknown,
          withStorage,
          keepForMs: KEEP_FOR_MS,
          now: NOW,
          followed,
        }),
      ).toEqual({ before: CUTOFF, unapplied: false });
      expect(await kept(ledger)).toEqual(["e-2"]);
    }
  });

  it("keeps, in a ledger the database does not follow, what it lacks however far its cursor read", async () => {
    const ledger = await ledgerWith([entry("1", 5), entry("2", 3), entry("3", 2), entry("4", -1)]);
    const { withStorage } = opening(database({ held: ["e-1", "e-3"], cursor: Date.parse(at(-1)) }));
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
        followed: false,
      }),
    ).toEqual({ before: at(3), unapplied: true });
    expect(await kept(ledger)).toEqual(["e-2", "e-3", "e-4"]);
  });

  it("reads a ledger the database does not follow from its oldest entry, a page at a time", async () => {
    const ledger = await ledgerWith([entry("1", 5), entry("2", 4), entry("3", 3), entry("4", 2)]);
    const { withStorage } = opening(database({ held: ["e-1", "e-2", "e-3"] }));
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
        followed: false,
        pageSize: 1,
      }),
    ).toEqual({ before: at(2), unapplied: true });
    expect(await kept(ledger)).toEqual(["e-4"]);
  });

  it("reads again the entries at the very time the cursor less what it reads again stands at", async () => {
    const cursor = Date.parse(at(2));
    const ledger = await ledgerWith([
      entry("1", 5),
      { ...entry("2", 2 + FORGET_LEDGER_REREAD_MS / DAY), eventId: "A-2", personId: "p-A-2" },
    ]);
    const { withStorage } = opening(database({ cursor }));
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
      }),
    ).toEqual({
      before: at(2 + FORGET_LEDGER_REREAD_MS / DAY),
      unapplied: true,
    });
    expect(await kept(ledger)).toEqual(["A-2"]);
  });

  it("removes up to keepFor when the cursor stands past it", async () => {
    const ledger = await ledgerWith([entry("1", 5), entry("2", -1), entry("3", -2)]);
    const { withStorage } = opening(database({ cursor: Date.parse(at(-3)) }));
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
      }),
    ).toEqual({
      before: CUTOFF,
      unapplied: false,
    });
    expect(await kept(ledger)).toEqual(["e-2", "e-3"]);
  });

  it("reads the database's entries a page at a time", async () => {
    const ledger = await ledgerWith([entry("1", 5), entry("2", 4), entry("3", 3), entry("4", 2)]);
    const { withStorage } = opening(database({ held: ["e-1", "e-2", "e-3"] }));
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
        pageSize: 2,
      }),
    ).toEqual({ before: at(2), unapplied: true });
    expect(await kept(ledger)).toEqual(["e-4"]);
  });

  it("reads on past each page, one entry a page", async () => {
    const ledger = await ledgerWith([entry("1", 5), entry("2", 4), entry("3", 3)]);
    const { withStorage } = opening(database({ held: ["e-1", "e-2"] }));
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
        pageSize: 1,
      }),
    ).toEqual({ before: at(3), unapplied: true });
    expect(await kept(ledger)).toEqual(["e-3"]);
  });

  it("writes nothing when the oldest entry is one the database has yet to apply", async () => {
    const ledger = await ledgerWith([entry("1", 3), entry("2", 2)]);
    const prunes: string[] = [];
    const { withStorage } = opening(database({ held: ["e-2"] }));
    expect(
      await prune({
        ledger: {
          read: ledger.read,
          fence: ledger.fence,
          prune: async ({ before }) => {
            prunes.push(before);
          },
        },
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
      }),
    ).toEqual({ before: at(3), unapplied: true });
    expect(prunes).toEqual([]);
  });

  it("removes every entry older than keepFor across pages when the database applied them all", async () => {
    const ledger = await ledgerWith([entry("1", 5), entry("2", 4), entry("3", 3), entry("4", 2)]);
    const { withStorage } = opening(database({ held: ["e-1", "e-2", "e-3", "e-4"] }));
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
        pageSize: 2,
      }),
    ).toEqual({ before: CUTOFF, unapplied: false });
    expect(await kept(ledger)).toEqual([]);
  });

  it("opens no database when no entry is older than keepFor, or none is there", async () => {
    for (const entries of [[], [entry("1", -1)], [entry("2", 0)]]) {
      const ledger = await ledgerWith(entries);
      const { opened, withStorage } = opening(database());
      expect(
        await prune({
          ledger,
          forgotten: unknown,
          withStorage,
          keepForMs: KEEP_FOR_MS,
          now: NOW,
        }),
      ).toEqual({ before: CUTOFF, unapplied: false });
      expect(opened.times).toBe(0);
      expect(await kept(ledger)).toEqual(entries.map(({ eventId }) => eventId));
    }
  });

  it("prunes a forgotten tenant's ledger past keepFor alone, without opening its database", async () => {
    const ledger = await ledgerWith([entry("1", 3), entry("2", -1)], FORGOTTEN);
    const { opened, withStorage } = opening(database());
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
      }),
    ).toEqual({
      before: CUTOFF,
      unapplied: false,
    });
    expect(opened.times).toBe(0);
    expect(await kept(ledger)).toEqual(["e-2"]);
  });

  it("prunes past keepFor alone, without opening its database, a tenant forgotten though its ledger's fence is open", async () => {
    const ledger = await ledgerWith([entry("1", 3), entry("2", -1)]);
    const { opened, withStorage } = opening(database());
    expect(
      await prune({
        ledger,
        forgotten: async () => true,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
      }),
    ).toEqual({ before: CUTOFF, unapplied: false });
    expect(opened.times).toBe(0);
    expect(await kept(ledger)).toEqual(["e-2"]);
  });

  it("prunes past keepFor alone a ledger whose database says the tenant was forgotten", async () => {
    const ledger = await ledgerWith([entry("1", 3), entry("2", -1)]);
    const { withStorage } = opening(database({ fence: FORGOTTEN }));
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
      }),
    ).toEqual({
      before: CUTOFF,
      unapplied: false,
    });
    expect(await kept(ledger)).toEqual(["e-2"]);
  });

  it("keeps every entry for a database that holds no table yet", async () => {
    const ledger = await ledgerWith([entry("1", 3), entry("2", -1)]);
    const { withStorage } = opening(null);
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
      }),
    ).toEqual({
      before: at(3),
      unapplied: true,
    });
    expect(await kept(ledger)).toEqual(["e-1", "e-2"]);
  });

  it("removes a disclosure the database holds as it was recorded, and keeps one it lacks", async () => {
    const stored: StoredDisclosure = {
      person: "p-1",
      ...DISCLOSURE,
      firstAt: at(3),
      lastAt: at(3),
    };
    for (const [differing, expected] of [
      [{}, { before: CUTOFF, unapplied: false }],
      [{ port: "other" }, { before: at(3), unapplied: true }],
      [{ recipient: "Other Mail" }, { before: at(3), unapplied: true }],
      [{ kind: "controller" }, { before: at(3), unapplied: true }],
      [{ country: "FR" }, { before: at(3), unapplied: true }],
      [{ safeguard: "scc" }, { before: at(3), unapplied: true }],
      [{ category: "billing" }, { before: at(3), unapplied: true }],
    ] as const) {
      const ledger = await ledgerWith([
        entry("1", 3, { disclosure: DISCLOSURE, committed: false }),
        entry("2", -1),
      ]);
      const { withStorage } = opening(database({ disclosures: [{ ...stored, ...differing }] }));
      expect(
        await prune({
          ledger,
          forgotten: unknown,
          withStorage,
          keepForMs: KEEP_FOR_MS,
          now: NOW,
        }),
      ).toEqual(expected);
    }
  });

  it("removes a disclosure a forgetting of its category came after, which told the recipient", async () => {
    const forgetting = (
      timestamp: string,
      categories: readonly string[],
      expired: readonly string[] = [],
    ) =>
      ({
        type: "PersonalDataForgotten",
        timestamp,
        payload: { categories, expired },
      }) as unknown as StoredEvent;
    for (const [events, expected] of [
      [[forgetting(at(2), ["contact"])], { before: CUTOFF, unapplied: false }],
      [[forgetting(at(2), [], ["contact"])], { before: CUTOFF, unapplied: false }],
      [[forgetting(at(3), ["contact"])], { before: CUTOFF, unapplied: false }],
      [[forgetting(at(4), ["contact"])], { before: at(3), unapplied: true }],
      [[forgetting(at(2), ["billing"])], { before: at(3), unapplied: true }],
    ] as const) {
      const ledger = await ledgerWith([
        entry("1", 3, { disclosure: DISCLOSURE, committed: false }),
      ]);
      const { withStorage } = opening(database({ events }));
      expect(
        await prune({
          ledger,
          forgotten: unknown,
          withStorage,
          keepForMs: KEEP_FOR_MS,
          now: NOW,
        }),
      ).toEqual(expected);
    }
  });
});

const key = (
  fingerprint: string,
  category = "default",
  retainedSince: string | null = null,
): HeldPersonalKey => ({
  category,
  key: { key: "wrapped", fingerprint, kid: null },
  retainedSince,
  lastActiveAt: null,
});

// `p-1`'s intention whose commit the database lacks, older than keepFor, and an entry younger.
const pruneIntention = async (
  intention: { readonly [Key in keyof ForgetLedgerEntry]?: ForgetLedgerEntry[Key] | undefined },
  args: DatabaseArgs,
): Promise<unknown> => {
  const ledger = await ledgerWith([
    entry("1", 3, { committed: false, fingerprints: ["f-1"], ...intention } as ForgetLedgerEntry),
    entry("2", -1),
  ]);
  const { withStorage } = opening(database(args));
  return prune({
    ledger,
    forgotten: unknown,
    withStorage,
    keepForMs: KEEP_FOR_MS,
    now: NOW,
  });
};

const REMOVED = { before: CUTOFF, unapplied: false };
const KEPT = { before: at(3), unapplied: true };

describe("pruning intentions nothing applies, with no app running", () => {
  it("removes a forgetting's intention when the person holds no key it covers and names, as the app's categories read it", async () => {
    for (const [intention, keys, expected] of [
      [{}, [], REMOVED],
      [{}, [key("f-1")], KEPT],
      [{}, [key("f-2")], REMOVED],
      [{ fingerprints: ["f-2", "f-1"] }, [key("f-1")], KEPT],
      [{ fingerprints: undefined }, [key("f-2")], KEPT],
      // A category the app no longer has holds no key to forget.
      [{ categories: ["billing"] }, [key("f-1", "billing")], REMOVED],
      [{ categories: ["contact", "billing"] }, [key("f-1", "billing")], REMOVED],
      [{ categories: ["contact"] }, [key("f-1", "contact")], KEPT],
      // What an earlier forgetting kept, an objection ends, and a request does not.
      [{ categories: ["contact"], reason: "objection" }, [key("f-1", "contact", at(10))], KEPT],
      [{ categories: ["contact"] }, [key("f-1", "contact", at(10))], REMOVED],
      [{ categories: null, reason: "objection" }, [key("f-1", "default", at(10))], REMOVED],
      [{ categories: [] }, [key("f-1")], REMOVED],
    ] as const) {
      expect(await pruneIntention(intention, { keys })).toEqual(expected);
    }
  });

  it("removes a retention's intention whose keys the retention would not forget now, as the app's retention reads them", async () => {
    const idle = (days: number) => ({
      ...key("f-1", "contact"),
      lastActiveAt: new Date(NOW.getTime() - days * DAY).toISOString(),
    });
    for (const [intention, args, expected] of [
      // Past `contact`'s 30 days, and recorded as the retention reads it: due.
      [{ categories: ["contact"] }, { keys: [idle(31)] }, KEPT],
      [{ categories: ["contact"] }, { keys: [idle(29)] }, REMOVED],
      [
        { categories: ["contact"] },
        { keys: [idle(31)], person: { lastActiveAt: at(0), restrictedSince: at(1) } },
        REMOVED,
      ],
      // The person as a whole, under the app's retention, which this app does not set.
      [{ categories: null }, { keys: [idle(31)], person: { lastActiveAt: at(40) } }, REMOVED],
    ] as const) {
      expect(await pruneIntention({ reason: "retention", ...intention }, args)).toEqual(expected);
    }
  });

  it("removes a forgetting's intention whose keys a later forgetting destroyed in a ledger the database does not follow", async () => {
    const ledger = await ledgerWith([
      entry("1", 3, { committed: false, fingerprints: ["f-1"] }),
      entry("2", -1),
    ]);
    const { withStorage } = opening(database({ cursor: Date.parse(at(-1)) }));
    expect(
      await prune({
        ledger,
        forgotten: unknown,
        withStorage,
        keepForMs: KEEP_FOR_MS,
        now: NOW,
        followed: false,
      }),
    ).toEqual(REMOVED);
  });

  it("keeps a committed entry the database lacks, though the person holds no key it names", async () => {
    expect(await pruneIntention({ committed: undefined }, {})).toEqual(KEPT);
  });

  it("keeps an intention written where the database stood further than it stands now", async () => {
    const reached = { generation: 2, position: 10 };
    for (const [generation, position, expected] of [
      [2, 9, KEPT],
      [1, 50, KEPT],
      [2, 10, REMOVED],
      [2, 11, REMOVED],
      [3, 0, REMOVED],
    ] as const) {
      expect(await pruneIntention({ reached }, { generation, position })).toEqual(expected);
    }
  });

  it("removes a change of restrictions' intention the database holds a later change after", async () => {
    const change = (type: string, id: string, timestamp: string) =>
      ({ type, id, timestamp }) as unknown as StoredEvent;
    const restriction = {
      type: PROCESSING_RESTRICTED_EVENT,
      payload: {},
    } as unknown as LedgerRestriction;
    for (const [events, expected] of [
      [[], KEPT],
      [[change(PROCESSING_RESTRICTION_LIFTED_EVENT, "e-later", at(2))], REMOVED],
      [[change(PROCESSING_RESTRICTION_LIFTED_EVENT, "e-0", at(3))], KEPT],
      [[change(PROCESSING_RESTRICTION_LIFTED_EVENT, "e-9", at(3))], REMOVED],
      [[change(PROCESSING_RESTRICTION_LIFTED_EVENT, "e-earlier", at(4))], KEPT],
      [[change("CustomerRegistered", "e-later", at(2))], KEPT],
    ] as const) {
      expect(await pruneIntention({ restriction, fingerprints: undefined }, { events })).toEqual(
        expected,
      );
    }
  });

  it("removes a change of restrictions' intention when the restrictions held are already what it left", async () => {
    const since = at(4);
    const left = [{ ground: "accuracy-contested", categories: null, since }];
    const restriction = (type: string) =>
      ({ type, payload: { restrictions: left } }) as unknown as LedgerRestriction;
    const row: StoredRestriction = { ground: "accuracy-contested", category: null, since };
    for (const [type, rows, expected] of [
      [PROCESSING_RESTRICTED_EVENT, [], KEPT],
      [PROCESSING_RESTRICTED_EVENT, [row], REMOVED],
      [PROCESSING_RESTRICTION_LIFTED_EVENT, [row], REMOVED],
      // An announced lift changes no row: it is due until a later change is held.
      [PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT, [row], KEPT],
    ] as const) {
      expect(
        await pruneIntention(
          { restriction: restriction(type), fingerprints: undefined },
          { restrictions: rows },
        ),
      ).toEqual(expected);
    }
  });

  it("removes a redaction's intention once it would make no field unreadable, as the app's aggregates mark them", async () => {
    const sealed = (person: string, fingerprint: string) => ({
      $personal: { person, key: fingerprint, iv: "iv", data: "data" },
    });
    const registered = (email: unknown, type = "CustomerRegistered") =>
      ({
        id: "c-1",
        aggregateType: "customer",
        aggregateId: "c-1",
        type,
        person: "p-1",
        payload: { customerId: "c-1", email },
      }) as unknown as StoredEvent;
    const redaction = {
      events: [
        {
          id: "c-1",
          aggregateType: "customer",
          aggregateId: "c-1",
          type: "CustomerRegistered",
          fields: ["email", "customerId"],
        },
      ],
    };
    for (const [stored, keys, expected] of [
      [[registered(sealed("p-1", "f-1"))], [key("f-1")], KEPT],
      // Kept past a forgetting, it still opens what it sealed.
      [[registered(sealed("p-1", "f-1"))], [key("f-1", "default", at(10))], KEPT],
      [[registered("ana@example.com")], [], KEPT],
      // Its key gone, or sealed for good by a redaction since, it reads as redacted already.
      [[registered(sealed("p-1", "f-1"))], [], REMOVED],
      [[registered(sealed("p-1", "f-1"))], [key("f-2")], REMOVED],
      [[registered(sealed("p-2", "f-1"))], [key("f-1")], REMOVED],
      [[registered(null)], [key("f-1")], REMOVED],
      [[registered(sealed("p-1", "f-1"), "CustomerRenamed")], [key("f-1")], REMOVED],
      [
        [{ ...registered(sealed("p-1", "f-1")), person: "p-2" } as StoredEvent],
        [key("f-1")],
        REMOVED,
      ],
      [[], [key("f-1")], REMOVED],
    ] as const) {
      expect(
        await pruneIntention({ redaction, fingerprints: undefined }, { stored, keys }),
      ).toEqual(expected);
    }
  });
});

// A database without Bounda's tables decides nothing with the app's rules.
const NO_TABLES = (): ReconciliationRules => {
  throw new Error("no rules are read for a database without tables");
};

describe("entries kept in a ledger the database does not follow", () => {
  const first = entry("1", 5);
  const second = entry("2", 3);
  const third = entry("3", 3, { eventId: "e-3b" });
  const young = entry("4", -1);
  // Exactly keepFor old, as the younger ones, is not asked.
  const atCutoff = entry("5", 0);
  const kept: readonly ForgetLedgerEntry[] = [first, second, third, atCutoff, young];

  it("are read by no app when the ledger the configuration names lacks one older than keepFor, from where the prune stopped, or holds it before where the reconciliation reads", async () => {
    const cases: readonly (readonly [
      readonly ForgetLedgerEntry[],
      string,
      string,
      number,
      boolean,
    ])[] = [
      [kept, at(5), at(6), 1, true],
      [[second, third], at(3), at(6), 1, true],
      // Younger than keepFor, or older than where the prune stopped: not asked.
      [[first, second, third], at(5), at(6), 1, true],
      [[second, third, young], at(3), at(6), 100, true],
      [[first, third], at(5), at(6), 100, false],
      [[first, second], at(5), at(6), 1, false],
      // At the same time, another id, before or after it.
      [[first, entry("2", 3, { eventId: "e-1" }), third], at(5), at(6), 1, false],
      [[first, entry("2", 3, { eventId: "e-9" }), third], at(5), at(6), 1, false],
      [[first, entry("x", 4), second, third], at(5), at(6), 1, true],
      [[], at(-2), at(6), 100, true],
      // Before what the reconciliation reads again, it is read nowhere.
      [kept, at(5), at(4), 100, false],
      [kept, at(3), at(3), 100, true],
      // Another entry of another time comes next: it is not there.
      [[first, young], at(5), at(6), 100, false],
    ];
    for (const [named, before, readFrom, pageSize, expected] of cases) {
      const stranded = await strandedEntries({
        storage: null,
        rules: NO_TABLES,
        now: NOW,
        ledger: await ledgerWith(kept),
        named: await ledgerWith(named),
        readFrom,
        after: { forgottenAt: before, eventId: "" },
        until: CUTOFF,
        limit: 1,
        pageSize,
      });
      expect(stranded.length === 0).toBe(expected);
    }
  });
});

describe("entries no app of the tenant applies", () => {
  const applies = entry("1", 5, { fingerprints: ["f-1"] });
  const later = entry("1", 3, { eventId: "e-1b", fingerprints: ["f-1"] });
  const nobody = entry("2", 4);
  const retained = entry("1", 4, { eventId: "e-1c", reason: "retention" });
  const storage = database({ keys: [key("f-1")] });

  const stranded = async (
    args: Partial<Parameters<typeof strandedEntries>[0]> &
      Pick<Parameters<typeof strandedEntries>[0], "ledger" | "named" | "readFrom">,
  ) =>
    (
      await strandedEntries({
        storage,
        rules: () => RULES,
        now: NOW,
        limit: Number.POSITIVE_INFINITY,
        ...args,
      })
    ).map(({ eventId }) => eventId);

  it("lists, in the ledger the configuration names, those before where its reconciliation reads that something still applies", async () => {
    const ledger = await ledgerWith([applies, nobody, retained, later]);
    expect(await stranded({ ledger, named: null, readFrom: at(-1) })).toEqual(["e-1", "e-1b"]);
    expect(await stranded({ ledger, named: null, readFrom: at(4) })).toEqual(["e-1"]);
    expect(await stranded({ ledger, named: null, readFrom: at(4), until: at(5) })).toEqual([]);
    expect(await stranded({ ledger, named: null, readFrom: at(-1), limit: 1 })).toEqual(["e-1"]);
    // What the database holds is applied.
    expect(
      await stranded({
        ledger,
        named: null,
        readFrom: at(-1),
        storage: database({ keys: [key("f-1")], held: ["e-1"] }),
      }),
    ).toEqual(["e-1b"]);
  });

  it("lists, in another store, those the ledger the configuration names lacks, or holds only before where its reconciliation reads", async () => {
    const ledger = await ledgerWith([applies, nobody, retained, later]);
    expect(await stranded({ ledger, named: await ledgerWith([later]), readFrom: at(6) })).toEqual([
      "e-1",
    ]);
    expect(
      await stranded({ ledger, named: await ledgerWith([applies, later]), readFrom: at(4) }),
    ).toEqual(["e-1"]);
    expect(
      await stranded({
        ledger,
        named: await ledgerWith([later]),
        readFrom: at(6),
        after: { forgottenAt: at(4), eventId: "" },
      }),
    ).toEqual([]);
  });
});
