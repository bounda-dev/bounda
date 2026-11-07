import { beforeEach, describe, expect, it } from "vitest";
import type { ForgetLedger, ForgetLedgerEntry } from "../storage/forget-ledger.ts";

export interface ForgetLedgerContractArgs {
  /**
   * An empty backing store, as what opens a ledger for each tenant over it.
   */
  readonly create: () => Promise<(tenant?: string) => Promise<ForgetLedger>>;
}

export interface ForgetLedgerContractFunction {
  (args: ForgetLedgerContractArgs): void;
}

const entry = (personId: string, eventId: string, minute: number): ForgetLedgerEntry => ({
  personId,
  eventId,
  forgottenAt: new Date(Date.UTC(2026, 10, 7, 12, minute)).toISOString(),
});

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
    let ledgerFor: (tenant?: string) => Promise<ForgetLedger>;
    let ledger: ForgetLedger;

    beforeEach(async () => {
      ledgerFor = await create();
      ledger = await ledgerFor();
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
  });
};
