import { beforeEach, describe, expect, it } from "vitest";
import type { ForgetLedger, ForgetLedgerEntry } from "../storage/forget-ledger.ts";
import type { TenantFence } from "../storage/tenant-fence.ts";

export interface ForgetLedgerContractArgs {
  /**
   * An empty backing store, as what opens a ledger for each tenant over it.
   */
  readonly create: () => Promise<(tenant: string) => Promise<ForgetLedger>>;
}

export interface ForgetLedgerContractFunction {
  (args: ForgetLedgerContractArgs): void;
}

const entry = (
  personId: string,
  eventId: string,
  minute: number,
  categories: readonly string[] | null = null,
): ForgetLedgerEntry => ({
  personId,
  eventId,
  forgottenAt: new Date(Date.UTC(2026, 10, 7, 12, minute)).toISOString(),
  categories,
  reason: "requested",
  fingerprints: [`k-${personId}`],
});

const FROZEN: TenantFence = {
  state: "frozen",
  tenant: "acme",
  since: new Date(Date.UTC(2026, 10, 7, 13)).toISOString(),
};
const FORGOTTEN: TenantFence = { ...FROZEN, state: "forgotten" };
const LATER = new Date(Date.UTC(2026, 10, 7, 14)).toISOString();

const readAll = async (ledger: ForgetLedger, limit = 2): Promise<ForgetLedgerEntry[]> => {
  const all: ForgetLedgerEntry[] = [];
  for (;;) {
    const last = all.at(-1);
    const page = await ledger.read({ limit, ...(last === undefined ? {} : { after: last }) });
    all.push(...page);
    if (page.length < limit) return all;
  }
};

/**
 * The behaviour every forget ledger must exhibit. Call it inside a `describe` of the ledger's
 * test file with a factory that empties a store and opens ledgers over it.
 */
export const forgetLedgerContract: ForgetLedgerContractFunction = ({ create }) => {
  describe("forget ledger contract", () => {
    let ledgerFor: (tenant: string) => Promise<ForgetLedger>;
    let ledger: ForgetLedger;

    beforeEach(async () => {
      ledgerFor = await create();
      ledger = await ledgerFor("tenant-a");
    });

    it("keeps the categories each forgetting asked for, none for a person forgotten as a whole", async () => {
      const entries = [
        entry("p-1", "e-1", 1),
        entry("p-2", "e-2", 2, ["marketing"]),
        entry("p-3", "e-3", 3, ["marketing", "invoices"]),
        entry("p-4", "e-4", 4, []),
      ];
      await ledger.append(entries);
      expect(await readAll(ledger, 10)).toEqual(entries);
    });

    it("keeps the reason each forgetting was asked with", async () => {
      const entries: ForgetLedgerEntry[] = [
        entry("p-1", "e-1", 1),
        { ...entry("p-2", "e-2", 2, ["marketing"]), reason: "objection" },
        { ...entry("p-3", "e-3", 3, ["marketing"]), reason: "retention" },
      ];
      await ledger.append(entries);
      expect((await readAll(ledger, 10)).map(({ reason }) => reason)).toEqual([
        "requested",
        "objection",
        "retention",
      ]);
    });

    it("keeps the change of restrictions an entry records, in order with the forgettings", async () => {
      const restrictions = Array.from({ length: 40 }, (_, index) => ({
        ground: "accuracy-contested" as const,
        categories: [`category-with-a-long-name-${index}`],
        since: "2026-11-07T12:00:00.000Z",
      }));
      const entries: ForgetLedgerEntry[] = [
        entry("p-1", "e-1", 1),
        {
          personId: "p-2",
          eventId: "e-2",
          forgottenAt: new Date(Date.UTC(2026, 10, 7, 12, 2)).toISOString(),
          categories: null,
          reason: "requested",
          restriction: {
            type: "ProcessingRestricted",
            payload: {
              personId: "p-2",
              ground: "accuracy-contested",
              categories: restrictions.flatMap(({ categories }) => categories),
              restrictions,
            },
          },
        },
        {
          personId: "p-2",
          eventId: "e-3",
          forgottenAt: new Date(Date.UTC(2026, 10, 7, 12, 3)).toISOString(),
          categories: null,
          reason: "requested",
          restriction: {
            type: "ProcessingRestrictionLiftAnnounced",
            payload: {
              personId: "p-2",
              grounds: ["accuracy-contested"],
              categories: null,
              liftsAt: "2026-11-14T12:03:00.000Z",
            },
          },
        },
      ];
      await ledger.append(entries);
      expect(await readAll(ledger, 10)).toEqual(entries);
    });

    it("keeps the redaction an entry records, however many events it names", async () => {
      const events = Array.from({ length: 40 }, (_, index) => ({
        id: `event-with-a-long-id-${index}`,
        aggregateType: "customer",
        aggregateId: "p-2",
        type: "CustomerRegistered",
        fields: ["email", "phone"],
      }));
      const entries: ForgetLedgerEntry[] = [
        entry("p-1", "e-1", 1),
        {
          personId: "p-2",
          eventId: "e-2",
          forgottenAt: new Date(Date.UTC(2026, 10, 7, 12, 2)).toISOString(),
          categories: null,
          reason: "requested",
          redaction: { events },
        },
        {
          personId: "p-3",
          eventId: "e-3",
          forgottenAt: new Date(Date.UTC(2026, 10, 7, 12, 3)).toISOString(),
          categories: null,
          reason: "requested",
          redaction: { events: events.slice(0, 1) },
        },
      ];
      await ledger.append(entries);
      expect(await readAll(ledger, 10)).toEqual(entries);
    });

    it("keeps the disclosure an entry records", async () => {
      const entries: ForgetLedgerEntry[] = [
        entry("p-1", "e-1", 1),
        {
          personId: "p-2",
          eventId: "e-2",
          forgottenAt: new Date(Date.UTC(2026, 10, 7, 12, 2)).toISOString(),
          categories: null,
          reason: "requested",
          disclosure: {
            port: "customer.mailer",
            recipient: "Mailchimp",
            kind: "processor",
            country: "US",
            safeguard: "standard-contractual-clauses",
            category: "contact",
          },
        },
        {
          personId: "p-3",
          eventId: "e-3",
          forgottenAt: new Date(Date.UTC(2026, 10, 7, 12, 3)).toISOString(),
          categories: null,
          reason: "requested",
          disclosure: {
            port: "order.crm",
            recipient: "Brevo",
            kind: "third-party",
            country: "FR",
            safeguard: null,
            category: "default",
          },
        },
      ];
      await ledger.append(entries);
      expect(await readAll(ledger, 10)).toEqual(entries);
    });

    it("reads nothing from an empty ledger", async () => {
      expect(await ledger.read({ limit: 10 })).toEqual([]);
      expect(
        await ledger.read({
          after: { forgottenAt: entry("c-1", "e-1", 0).forgottenAt, eventId: "" },
          limit: 10,
        }),
      ).toEqual([]);
    });

    it("reads entries in order of time, then of event id, whatever order they came in", async () => {
      await ledger.append([entry("c-3", "e-9", 5), entry("c-1", "e-2", 1)]);
      await ledger.append([entry("c-2", "e-10", 5), entry("c-4", "e-1", 1)]);
      expect(await ledger.read({ limit: 10 })).toEqual([
        entry("c-4", "e-1", 1),
        entry("c-1", "e-2", 1),
        entry("c-2", "e-10", 5),
        entry("c-3", "e-9", 5),
      ]);
    });

    it("reads past a position in bounded pages, the position's own entry left out", async () => {
      const entries = [1, 2, 3, 4, 5].map((minute) => entry(`c-${minute}`, `e-${minute}`, minute));
      await ledger.append(entries);
      expect(await readAll(ledger)).toEqual(entries);
      expect(await ledger.read({ after: entries[1] as ForgetLedgerEntry, limit: 2 })).toEqual(
        entries.slice(2, 4),
      );
      expect(
        await ledger.read({
          after: { forgottenAt: (entries[2] as ForgetLedgerEntry).forgottenAt, eventId: "" },
          limit: 10,
        }),
      ).toEqual(entries.slice(2));
      expect(await ledger.read({ after: entries[4] as ForgetLedgerEntry, limit: 2 })).toEqual([]);
    });

    it("keeps an event's entry once, however often it is appended", async () => {
      await ledger.append([entry("c-1", "e-1", 1)]);
      await ledger.append([entry("c-1", "e-1", 1), entry("c-2", "e-2", 2)]);
      await ledger.append([entry("c-1", "e-1", 1)]);
      expect(await ledger.read({ limit: 10 })).toEqual([
        entry("c-1", "e-1", 1),
        entry("c-2", "e-2", 2),
      ]);
    });

    it("keeps an intention uncommitted however often it is appended until its committed copy comes, and committed for good after", async () => {
      const intention: ForgetLedgerEntry = { ...entry("c-1", "e-1", 1), committed: false };
      await ledger.append([intention]);
      await ledger.append([intention]);
      await ledger.append([{ ...entry("c-2", "e-2", 2), committed: false }]);
      await ledger.append([{ ...entry("c-2", "e-2", 2), committed: false }, intention]);
      expect(await ledger.read({ limit: 10 })).toEqual([
        intention,
        { ...entry("c-2", "e-2", 2), committed: false },
      ]);
      await ledger.append([entry("c-1", "e-1", 1)]);
      await ledger.append([intention]);
      const [read] = await ledger.read({ limit: 10 });
      expect(read).toEqual(entry("c-1", "e-1", 1));
      expect(read).not.toHaveProperty("committed");
    });

    it("keeps where the database stood with an intention, as large as a position gets, and reads it committed after", async () => {
      const reached = { position: Number.MAX_SAFE_INTEGER, generation: 3 };
      const intention: ForgetLedgerEntry = { ...entry("c-1", "e-1", 1), committed: false, reached };
      await ledger.append([intention]);
      expect(await ledger.read({ limit: 10 })).toEqual([intention]);
      await ledger.append([entry("c-1", "e-1", 1)]);
      const [read] = await ledger.read({ limit: 10 });
      expect(read).not.toHaveProperty("committed");
      expect(read).toMatchObject(entry("c-1", "e-1", 1));
    });

    it("keeps committed an entry appended committed and as an intention in one call, either way round", async () => {
      const first: ForgetLedgerEntry = { ...entry("c-1", "e-1", 1), committed: false };
      const second: ForgetLedgerEntry = { ...entry("c-2", "e-2", 2), committed: false };
      await ledger.append([first, entry("c-1", "e-1", 1)]);
      await ledger.append([entry("c-2", "e-2", 2), second]);
      expect(await ledger.read({ limit: 10 })).toEqual([
        entry("c-1", "e-1", 1),
        entry("c-2", "e-2", 2),
      ]);
    });

    it("keeps each entry's reason and the keys it names, none, or none recorded", async () => {
      const retained: ForgetLedgerEntry = {
        ...entry("c-1", "e-1", 1),
        reason: "retention",
        fingerprints: ["k-1", "k-2"],
      };
      const keyless: ForgetLedgerEntry = { ...entry("c-2", "e-2", 2), fingerprints: [] };
      const { fingerprints: _, ...unrecorded } = entry("c-3", "e-3", 3);
      await ledger.append([retained, keyless, unrecorded]);
      const read = await ledger.read({ limit: 10 });
      expect(read).toEqual([retained, keyless, unrecorded]);
      expect(read[2]).not.toHaveProperty("fingerprints");
    });

    it("keeps one person's forgettings apart, each under its event", async () => {
      await ledger.append([entry("c-1", "e-1", 1), entry("c-1", "e-2", 2)]);
      expect(await ledger.read({ limit: 10 })).toEqual([
        entry("c-1", "e-1", 1),
        entry("c-1", "e-2", 2),
      ]);
    });

    it("appends nothing for no entries, and many at once", async () => {
      await ledger.append([]);
      const many = Array.from({ length: 60 }, (_, index) =>
        entry(`c-${index}`, `e-${String(index).padStart(2, "0")}`, 1),
      );
      await ledger.append(many);
      expect(await readAll(ledger, 25)).toEqual(many);
    });

    it("prunes the entries older than a time, the rest and other tenants' left as they were", async (context) => {
      if (ledger.prune === undefined) context.skip("the ledger expires entries on its own");
      const other = await ledgerFor("tenant-b");
      const entries = [1, 2, 3].map((minute) => entry(`c-${minute}`, `e-${minute}`, minute));
      await ledger.append(entries);
      await other.append(entries);
      await ledger.prune?.({ before: (entries[1] as ForgetLedgerEntry).forgottenAt });
      expect(await ledger.read({ limit: 10 })).toEqual(entries.slice(1));
      expect(await other.read({ limit: 10 })).toEqual(entries);
      await ledger.prune?.({ before: entry("c-0", "e-0", 0).forgottenAt });
      expect(await ledger.read({ limit: 10 })).toEqual(entries.slice(1));
      await ledger.prune?.({ before: entry("c-9", "e-9", 9).forgottenAt });
      expect(await ledger.read({ limit: 10 })).toEqual([]);
      await ledger.append([entries[0] as ForgetLedgerEntry]);
      expect(await ledger.read({ limit: 10 })).toEqual(entries.slice(0, 1));
    });

    it("keeps each tenant's entries apart", async () => {
      const other = await ledgerFor("tenant-b");
      const third = await ledgerFor("tenant-c");
      await ledger.append([entry("c-1", "e-1", 1)]);
      await other.append([entry("c-2", "e-2", 2), entry("c-1", "e-1", 1)]);
      expect(await ledger.read({ limit: 10 })).toEqual([entry("c-1", "e-1", 1)]);
      expect(await other.read({ limit: 10 })).toEqual([
        entry("c-1", "e-1", 1),
        entry("c-2", "e-2", 2),
      ]);
      expect(await third.read({ limit: 10 })).toEqual([]);
    });

    it("raises a mark only upward, keeps it apart from the entries, and each tenant's apart", async () => {
      const other = await ledgerFor("tenant-b");
      expect(await ledger.readMark("restore:generation")).toBe(0);
      await ledger.raiseMark("restore:generation", 7);
      await ledger.raiseMark("restore:generation", 5);
      expect(await ledger.readMark("restore:generation")).toBe(7);
      await ledger.raiseMark("restore:generation", 9);
      expect(await ledger.readMark("restore:generation")).toBe(9);
      expect(await ledger.readMark("another")).toBe(0);
      expect(await other.readMark("restore:generation")).toBe(0);
      expect(await ledger.read({ limit: 10 })).toEqual([]);
    });

    it("clears every entry and mark of its store, other stores' left as they were, and keeps again after", async () => {
      const other = await ledgerFor("tenant-b");
      const entries = [1, 2, 3].map((minute) => entry(`c-${minute}`, `e-${minute}`, minute));
      await ledger.append(entries);
      await other.append(entries);
      await ledger.raiseMark("restore:generation", 7);
      await ledger.raiseMark("another", 3);
      await other.raiseMark("restore:generation", 5);
      // Called again while it removed part only, as the runtime does.
      while (!(await ledger.clear()));
      expect(await ledger.read({ limit: 10 })).toEqual([]);
      expect(await ledger.readMark("restore:generation")).toBe(0);
      expect(await ledger.readMark("another")).toBe(0);
      expect(await other.read({ limit: 10 })).toEqual(entries);
      expect(await other.readMark("restore:generation")).toBe(5);
      expect(await ledger.clear()).toBe(true);
      expect(await ledger.read({ limit: 10 })).toEqual([]);
      await ledger.append([entries[0] as ForgetLedgerEntry]);
      await ledger.raiseMark("restore:generation", 2);
      expect(await ledger.read({ limit: 10 })).toEqual(entries.slice(0, 1));
      expect(await ledger.readMark("restore:generation")).toBe(2);
      // Reopened, as a restart opens it again.
      expect(await (await ledgerFor("tenant-a")).read({ limit: 10 })).toEqual(entries.slice(0, 1));
    });

    it("refuses appends and raised marks behind its fence, keeping nothing of them, and lets the rest through", async () => {
      const other = await ledgerFor("tenant-b");
      const kept = entry("c-1", "e-1", 1);
      await ledger.append([kept]);
      await ledger.raiseMark("restore:generation", 2);
      expect(await ledger.fence.read()).toEqual({ state: "open" });
      expect(await ledger.fence.set(FROZEN)).toEqual(FROZEN);
      // Reopened, as another instance opens it.
      const again = await ledgerFor("tenant-a");
      for (const fenced of [ledger, again]) {
        expect(await fenced.fence.read()).toEqual(FROZEN);
        await expect(fenced.append([entry("c-2", "e-2", 2)])).rejects.toMatchObject({
          code: "TENANT_FROZEN",
          tenant: "acme",
          frozenAt: FROZEN.since,
        });
        await expect(fenced.raiseMark("restore:generation", 5)).rejects.toMatchObject({
          code: "TENANT_FROZEN",
        });
      }
      expect(await ledger.read({ limit: 10 })).toEqual([kept]);
      expect(await ledger.readMark("restore:generation")).toBe(2);
      // Frozen again, it keeps the first time.
      expect(await ledger.fence.set({ ...FROZEN, since: LATER })).toEqual(FROZEN);
      // Another store's fence is its own.
      expect(await other.fence.read()).toEqual({ state: "open" });
      await other.append([entry("c-3", "e-3", 3)]);
      await ledger.prune?.({ before: entry("c-9", "e-9", 9).forgottenAt });
      expect(await ledger.read({ limit: 10 })).toEqual(ledger.prune === undefined ? [kept] : []);
      expect(await ledger.fence.set({ state: "open" })).toEqual({ state: "open" });
      await again.append([entry("c-2", "e-2", 2)]);
      await again.raiseMark("restore:generation", 5);
      expect((await ledger.read({ limit: 10 })).map(({ eventId }) => eventId)).toContain("e-2");
      expect(await ledger.readMark("restore:generation")).toBe(5);
    });

    it("keeps the fence of a forgotten tenant for good, past a clear", async () => {
      await ledger.append([entry("c-1", "e-1", 1)]);
      await ledger.raiseMark("restore:generation", 2);
      await ledger.fence.set(FROZEN);
      expect(await ledger.fence.set(FORGOTTEN)).toEqual(FORGOTTEN);
      while (!(await ledger.clear()));
      expect(await ledger.read({ limit: 10 })).toEqual([]);
      expect(await ledger.readMark("restore:generation")).toBe(0);
      expect(await ledger.fence.set({ state: "open" })).toEqual(FORGOTTEN);
      expect(await ledger.fence.set(FROZEN)).toEqual(FORGOTTEN);
      const again = await ledgerFor("tenant-a");
      expect(await again.fence.read()).toEqual(FORGOTTEN);
      await expect(again.append([entry("c-2", "e-2", 2)])).rejects.toMatchObject({
        code: "TENANT_FORGOTTEN",
        tenant: "acme",
        forgottenAt: FORGOTTEN.since,
      });
      await expect(again.raiseMark("restore:generation", 3)).rejects.toMatchObject({
        code: "TENANT_FORGOTTEN",
      });
      expect(await ledger.read({ limit: 10 })).toEqual([]);
      expect(await ledger.readMark("restore:generation")).toBe(0);
    });
  });
};
