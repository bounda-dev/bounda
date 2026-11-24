import { describe, expect, it } from "vitest";
import type { PruneForgetLedgerArgs } from "../../adapter/storage/forget-ledger.ts";
import { createRecordingLogger } from "../test-support.ts";
import { createForgottenLedger } from "./forgotten-ledger.ts";
import { HOLD_MS } from "./hold.ts";

const FORGETTING = { at: "2026-11-23T10:00:00.000Z", eventId: "tenant-forgotten" };
const AT = new Date(FORGETTING.at);
const MINUTE = 60_000;

const later = (ms: number): Date => new Date(AT.getTime() + ms);

// A ledger that holds nothing, for what these cases do not read.
const unread = { read: async () => [], readMark: async () => 0 };

describe("the forget ledger of a forgotten tenant", () => {
  it("clears the ledger at once when its reads show every write, and says so", async () => {
    let cleared = 0;
    const recording = createRecordingLogger();
    const ledger = createForgottenLedger({
      ledger: {
        ...unread,
        clear: async () => {
          cleared += 1;
          return true;
        },
      },
      keepForMs: null,
      reconcileEveryMs: MINUTE,
      tenant: "acme",
      logger: recording.logger,
    });
    expect(await ledger.clear(FORGETTING, AT)).toBeNull();
    expect(cleared).toBe(1);
    expect(recording.entries).toEqual([
      {
        level: "warn",
        message: "tenant forgotten: its recipients are told, and its forget ledger cleared",
        fields: { tenant: "acme" },
      },
    ]);
  });

  it("waits until every entry written before the forgetting shows in a ledger whose reads lag", async () => {
    let cleared = 0;
    const ledger = createForgottenLedger({
      ledger: {
        ...unread,
        visibilityDelayMs: MINUTE,
        clear: async () => {
          cleared += 1;
          return true;
        },
      },
      keepForMs: null,
      reconcileEveryMs: MINUTE,
      tenant: "acme",
      logger: createRecordingLogger().logger,
    });
    expect(await ledger.clear(FORGETTING, later(MINUTE - 1))).toEqual(later(MINUTE));
    expect(cleared).toBe(0);
    expect(await ledger.clear(FORGETTING, later(MINUTE))).toBeNull();
    expect(cleared).toBe(1);
  });

  it("asks to be run again at the next pass after a clear that removed part only, and says nothing yet", async () => {
    const recording = createRecordingLogger();
    const ledger = createForgottenLedger({
      ledger: { ...unread, clear: async () => false },
      keepForMs: null,
      reconcileEveryMs: MINUTE,
      tenant: "acme",
      logger: recording.logger,
    });
    expect(await ledger.clear(FORGETTING, later(5))).toEqual(later(6));
    expect(recording.entries).toEqual([]);
  });

  it("logs a clear that failed, and asks to be run again after a hold", async () => {
    const recording = createRecordingLogger();
    const ledger = createForgottenLedger({
      ledger: {
        ...unread,
        clear: () => Promise.reject(new Error("ledger down")),
      },
      keepForMs: null,
      reconcileEveryMs: MINUTE,
      tenant: "acme",
      logger: recording.logger,
    });
    expect(await ledger.clear(FORGETTING, later(5))).toEqual(later(5 + HOLD_MS));
    expect(recording.entries).toEqual([
      {
        level: "error",
        message: "the forgotten tenant's forget ledger could not be cleared",
        fields: expect.objectContaining({ tenant: "acme", errorName: "Error" }),
      },
    ]);
  });

  it("prunes past keepFor at most once every reconcileEvery, as a running tenant's reconciliation does", async () => {
    const pruned: PruneForgetLedgerArgs[] = [];
    const ledger = createForgottenLedger({
      ledger: {
        ...unread,
        clear: async () => true,
        prune: async (args) => {
          pruned.push(args);
        },
      },
      keepForMs: 10 * MINUTE,
      reconcileEveryMs: 5 * MINUTE,
      tenant: "acme",
      logger: createRecordingLogger().logger,
    });
    await ledger.retain(AT);
    await ledger.retain(later(5 * MINUTE - 1));
    await ledger.retain(later(5 * MINUTE));
    expect(pruned).toEqual([
      { before: later(-10 * MINUTE).toISOString() },
      { before: later(-5 * MINUTE).toISOString() },
    ]);
  });

  it("prunes nothing without keepFor, nor in a ledger that expires its entries itself", async () => {
    const pruned: PruneForgetLedgerArgs[] = [];
    const kept = createForgottenLedger({
      ledger: {
        ...unread,
        clear: async () => true,
        prune: async (args) => {
          pruned.push(args);
        },
      },
      keepForMs: null,
      reconcileEveryMs: MINUTE,
      tenant: "acme",
      logger: createRecordingLogger().logger,
    });
    await kept.retain(AT);
    expect(pruned).toEqual([]);
    const recording = createRecordingLogger();
    const expiring = createForgottenLedger({
      ledger: { ...unread, clear: async () => true },
      keepForMs: MINUTE,
      reconcileEveryMs: MINUTE,
      tenant: "acme",
      logger: recording.logger,
    });
    await expect(expiring.retain(AT)).resolves.toBeUndefined();
    expect(recording.entries).toEqual([]);
  });

  it("logs a prune that failed, and prunes again only once reconcileEvery has passed", async () => {
    const recording = createRecordingLogger();
    let calls = 0;
    const ledger = createForgottenLedger({
      ledger: {
        ...unread,
        clear: async () => true,
        prune: () => {
          calls += 1;
          return Promise.reject(new Error("ledger down"));
        },
      },
      keepForMs: MINUTE,
      reconcileEveryMs: MINUTE,
      tenant: "acme",
      logger: recording.logger,
    });
    await ledger.retain(AT);
    await ledger.retain(later(1));
    expect(calls).toBe(1);
    expect(recording.entries).toEqual([
      {
        level: "error",
        message: "the forgotten tenant's forget ledger could not be pruned",
        fields: expect.objectContaining({ tenant: "acme", errorName: "Error" }),
      },
    ]);
  });
});
