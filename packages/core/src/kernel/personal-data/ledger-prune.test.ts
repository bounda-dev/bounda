import { describe, expect, it } from "vitest";
import type { ForgetLedgerEntry, LedgerDisclosure } from "../../adapter/storage/forget-ledger.ts";
import type { StoredDisclosure } from "../../adapter/storage/recipient-store.ts";
import type { TenantFence } from "../../adapter/storage/tenant-fence.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createMemoryForgetLedgers } from "../../memory/forget-ledger.ts";
import { BOUNDA_AGGREGATE } from "../../modules/bounda-events.ts";
import { type AppliedStorage, pruneAsApplied } from "./ledger-prune.ts";
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

interface DatabaseArgs {
  // The events of the persons' `bounda` aggregate it holds, by id.
  readonly held?: readonly string[];
  readonly cursor?: number;
  readonly fence?: TenantFence;
  readonly disclosures?: readonly StoredDisclosure[];
  readonly events?: readonly StoredEvent[];
}

const database = ({
  held = [],
  cursor = 0,
  fence = OPEN,
  disclosures = [],
  events = [],
}: DatabaseArgs = {}): AppliedStorage =>
  ({
    checkpointStore: {
      get: async (name: string) => (name === FORGET_LEDGER_CURSOR ? cursor : 0),
    },
    eventStore: {
      readOne: async ({ aggregateType, eventId }: { aggregateType: string; eventId: string }) =>
        aggregateType === BOUNDA_AGGREGATE && held.includes(eventId)
          ? ({ id: eventId } as StoredEvent)
          : null,
      load: async () => ({ events, version: events.length }),
    },
    recipients: { disclosures: async () => disclosures },
    fence: { read: async () => fence, set: async (asked: TenantFence) => asked },
  }) as unknown as AppliedStorage;

const ledgerWith = async (entries: readonly ForgetLedgerEntry[], fence: TenantFence = OPEN) => {
  const ledger = createMemoryForgetLedgers().ledgerOf("acme");
  await ledger.append(entries);
  if (fence.state !== "open") await ledger.fence.set(fence);
  return ledger;
};

const kept = async (ledger: Awaited<ReturnType<typeof ledgerWith>>): Promise<readonly string[]> =>
  (await ledger.read({ limit: 100 })).map(({ eventId }) => eventId);

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
    expect(await pruneAsApplied({ ledger, withStorage, keepForMs: KEEP_FOR_MS, now: NOW })).toEqual(
      {
        before: CUTOFF,
        unapplied: false,
      },
    );
    expect(await kept(ledger)).toEqual(["e-3"]);
  });

  it("keeps, from the oldest entry the database lacks on, what its reconciliation has yet to read", async () => {
    const ledger = await ledgerWith([entry("1", 5), entry("2", 3), entry("3", 2), entry("4", -1)]);
    const { withStorage } = opening(database({ held: ["e-1", "e-3", "e-4"] }));
    expect(await pruneAsApplied({ ledger, withStorage, keepForMs: KEEP_FOR_MS, now: NOW })).toEqual(
      {
        before: at(3),
        unapplied: true,
      },
    );
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
    expect(await pruneAsApplied({ ledger, withStorage, keepForMs: KEEP_FOR_MS, now: NOW })).toEqual(
      {
        before: at(2 + (FORGET_LEDGER_REREAD_MS - 1) / DAY),
        unapplied: true,
      },
    );
    expect(await kept(ledger)).toEqual(["e-2", "e-3"]);
  });

  it("removes up to keepFor when the cursor stands past it", async () => {
    const ledger = await ledgerWith([entry("1", 5), entry("2", -1), entry("3", -2)]);
    const { withStorage } = opening(database({ cursor: Date.parse(at(-3)) }));
    expect(await pruneAsApplied({ ledger, withStorage, keepForMs: KEEP_FOR_MS, now: NOW })).toEqual(
      {
        before: CUTOFF,
        unapplied: false,
      },
    );
    expect(await kept(ledger)).toEqual(["e-2", "e-3"]);
  });

  it("reads the database's entries a page at a time", async () => {
    const ledger = await ledgerWith([entry("1", 5), entry("2", 4), entry("3", 3), entry("4", 2)]);
    const { withStorage } = opening(database({ held: ["e-1", "e-2", "e-3"] }));
    expect(
      await pruneAsApplied({ ledger, withStorage, keepForMs: KEEP_FOR_MS, now: NOW, pageSize: 2 }),
    ).toEqual({ before: at(2), unapplied: true });
    expect(await kept(ledger)).toEqual(["e-4"]);
  });

  it("removes every entry older than keepFor across pages when the database applied them all", async () => {
    const ledger = await ledgerWith([entry("1", 5), entry("2", 4), entry("3", 3), entry("4", 2)]);
    const { withStorage } = opening(database({ held: ["e-1", "e-2", "e-3", "e-4"] }));
    expect(
      await pruneAsApplied({ ledger, withStorage, keepForMs: KEEP_FOR_MS, now: NOW, pageSize: 2 }),
    ).toEqual({ before: CUTOFF, unapplied: false });
    expect(await kept(ledger)).toEqual([]);
  });

  it("opens no database when no entry is older than keepFor, or none is there", async () => {
    for (const entries of [[], [entry("1", -1)], [entry("2", 0)]]) {
      const ledger = await ledgerWith(entries);
      const { opened, withStorage } = opening(database());
      expect(
        await pruneAsApplied({ ledger, withStorage, keepForMs: KEEP_FOR_MS, now: NOW }),
      ).toEqual({ before: CUTOFF, unapplied: false });
      expect(opened.times).toBe(0);
      expect(await kept(ledger)).toEqual(entries.map(({ eventId }) => eventId));
    }
  });

  it("prunes a forgotten tenant's ledger past keepFor alone, without opening its database", async () => {
    const ledger = await ledgerWith([entry("1", 3), entry("2", -1)], FORGOTTEN);
    const { opened, withStorage } = opening(database());
    expect(await pruneAsApplied({ ledger, withStorage, keepForMs: KEEP_FOR_MS, now: NOW })).toEqual(
      {
        before: CUTOFF,
        unapplied: false,
      },
    );
    expect(opened.times).toBe(0);
    expect(await kept(ledger)).toEqual(["e-2"]);
  });

  it("prunes past keepFor alone a ledger whose database says the tenant was forgotten", async () => {
    const ledger = await ledgerWith([entry("1", 3), entry("2", -1)]);
    const { withStorage } = opening(database({ fence: FORGOTTEN }));
    expect(await pruneAsApplied({ ledger, withStorage, keepForMs: KEEP_FOR_MS, now: NOW })).toEqual(
      {
        before: CUTOFF,
        unapplied: false,
      },
    );
    expect(await kept(ledger)).toEqual(["e-2"]);
  });

  it("keeps every entry for a database that holds no table yet", async () => {
    const ledger = await ledgerWith([entry("1", 3), entry("2", -1)]);
    const { withStorage } = opening(null);
    expect(await pruneAsApplied({ ledger, withStorage, keepForMs: KEEP_FOR_MS, now: NOW })).toEqual(
      {
        before: at(3),
        unapplied: true,
      },
    );
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
        await pruneAsApplied({ ledger, withStorage, keepForMs: KEEP_FOR_MS, now: NOW }),
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
        await pruneAsApplied({ ledger, withStorage, keepForMs: KEEP_FOR_MS, now: NOW }),
      ).toEqual(expected);
    }
  });
});
