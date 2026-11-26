import { describe, expect, it, vi } from "vitest";
import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import { createMemoryForgetLedgers } from "../../memory/forget-ledger.ts";
import { type ApplyEntriesAgainArgs, applyEntriesAgain } from "./applied-again.ts";
import { FORGET_LEDGER_CURSOR, FORGET_LEDGER_REREAD_MS } from "./reconciliation.ts";
import { DEFAULT_TENANT } from "./tenant-keys.ts";

// What each entry applies is the reconciliation's, pinned where it decides it: here only the order
// of the checks around it and what is told of it.
const applied = vi.hoisted(() => new Map<string, string | null>());
vi.mock("./reconciliation.ts", async (actual) => ({
  ...(await actual<typeof import("./reconciliation.ts")>()),
  applyEntryAgain: async ({ entry }: { readonly entry: ForgetLedgerEntry }) =>
    applied.get(entry.eventId) ?? null,
}));

const CURSOR = Date.parse("2026-03-01T00:00:00.000Z");
const READ_FROM = new Date(CURSOR - FORGET_LEDGER_REREAD_MS).toISOString();

const entry = (eventId: string, forgottenAt: string): ForgetLedgerEntry => ({
  personId: `p-${eventId}`,
  categories: null,
  eventId,
  forgottenAt,
  reason: "requested",
});

const storage = {
  eventStore: { readOne: async () => null },
  recipients: { disclosures: async () => [] },
  checkpointStore: {
    get: async (name: string) => (name === FORGET_LEDGER_CURSOR ? CURSOR : 0),
  },
} as unknown as ApplyEntriesAgainArgs["storage"];

describe("applying entries again", () => {
  it("leaves to the reconciliation one the ledger holds from where it reads, and tells each person forgotten", async () => {
    const ledger = createMemoryForgetLedgers().ledgerOf(DEFAULT_TENANT);
    const atReadFrom = entry("at", READ_FROM);
    const before = entry("before", new Date(Date.parse(READ_FROM) - 1).toISOString());
    const restricted = entry("restricted", "2026-01-01T00:00:00.000Z");
    await ledger.append([atReadFrom, before]);
    applied.set("before", "forgetting");
    applied.set("restricted", "restriction");
    const forgotten: string[] = [];
    const done = await applyEntriesAgain({
      storage,
      ledger,
      entries: [atReadFrom, before, restricted],
      actor: undefined,
      forgotten: (personId: string) => forgotten.push(personId),
    } as unknown as ApplyEntriesAgainArgs);
    expect(done).toEqual([
      { personId: "p-at", eventId: "at", kind: "forgetting", outcome: "reconciled" },
      { personId: "p-before", eventId: "before", kind: "forgetting", outcome: "applied" },
      // What it applied says what it was.
      { personId: "p-restricted", eventId: "restricted", kind: "restriction", outcome: "applied" },
    ]);
    expect(forgotten).toEqual(["p-before"]);
  });

  it("names the operation that refuses an entry without a person's id", async () => {
    await expect(
      applyEntriesAgain({
        storage,
        ledger: null,
        entries: [entry("", READ_FROM), { ...entry("x", READ_FROM), personId: "" }],
        actor: undefined,
        forgotten: () => undefined,
      } as unknown as ApplyEntriesAgainArgs),
    ).rejects.toThrow(/applyAgain/);
  });
});
