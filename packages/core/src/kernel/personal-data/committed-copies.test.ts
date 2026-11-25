import { describe, expect, it } from "vitest";
import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import { fenceError } from "../../adapter/storage/tenant-fence.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../../modules/bounda-events.ts";
import { createRecordingLogger } from "../test-support.ts";
import { createCommittedCopies } from "./committed-copies.ts";
import { DEFAULT_TENANT } from "./tenant-keys.ts";

const NOW = new Date("2026-11-25T00:00:00.000Z");

const forgotten = (person: string, position: number): StoredEvent => ({
  ...pendingEvent({
    aggregateType: BOUNDA_AGGREGATE,
    aggregateId: person,
    version: 1,
    type: PERSONAL_DATA_FORGOTTEN_EVENT,
    payload: { reason: "requested" },
    id: `e-${person}`,
  }),
  timestamp: NOW.toISOString(),
  position,
});

const setUp = async () => {
  const inner = await memory().createForgetLedger({ tenant: DEFAULT_TENANT });
  const state = { failing: null as Error | null, late: false, appends: 0 };
  const ledger: ForgetLedger & { late(): boolean } = {
    ...inner,
    append: async (entries: readonly ForgetLedgerEntry[]) => {
      state.appends += 1;
      if (state.failing !== null) throw state.failing;
      await inner.append(entries);
    },
    late: () => state.late,
  };
  const { logger, entries } = createRecordingLogger("omit");
  const copies = createCommittedCopies({
    ledger,
    keepForMs: null,
    clock: createFixedClock(NOW),
    logger,
  });
  const committed = async () =>
    (await inner.read({ limit: 10 })).map(({ eventId, committed }) => ({ eventId, committed }));
  return { copies, state, committed, logged: entries };
};

describe("createCommittedCopies", () => {
  it("appends what a commit holds for the ledger, committed, and nothing for any other event", async () => {
    const { copies, state, committed } = await setUp();
    await copies.copy([pendingEvent({ aggregateId: "o-1", version: 1 }) as unknown as StoredEvent]);
    expect(state.appends).toBe(0);
    await copies.copy([forgotten("ana", 1)]);
    expect(await committed()).toEqual([{ eventId: "e-ana", committed: undefined }]);
  });

  it("keeps what the ledger did not take, and appends it again once it does", async () => {
    const { copies, state, committed, logged } = await setUp();
    state.failing = new Error("the ledger is down");
    await copies.copy([forgotten("ana", 1)]);
    await copies.retry();
    expect(await committed()).toEqual([]);
    const warned = () =>
      logged.filter(
        ({ message }) => message === "forget ledger did not take a commit; it is appended again",
      ).length;
    // Said once while the ledger stays down, however many retries meet it.
    expect(warned()).toBe(1);
    state.failing = null;
    await copies.retry();
    expect(await committed()).toEqual([{ eventId: "e-ana", committed: undefined }]);
    const appends = state.appends;
    await copies.retry();
    expect(state.appends).toBe(appends);
    // Down again after it took one, it is said again.
    state.failing = new Error("the ledger is down");
    await copies.copy([forgotten("bob", 2)]);
    expect(warned()).toBe(2);
  });

  it("asks nothing of a ledger whose call hangs, and appends once it no longer does", async () => {
    const { copies, state, committed } = await setUp();
    state.late = true;
    await copies.copy([forgotten("ana", 1)]);
    await copies.retry();
    expect(state.appends).toBe(0);
    state.late = false;
    await copies.copy([forgotten("bob", 2)]);
    await copies.retry();
    expect((await committed()).map(({ eventId }) => eventId).sort()).toEqual(["e-ana", "e-bob"]);
  });

  it("drops what the tenant's fence refuses, as the database refuses it too", async () => {
    const { copies, state } = await setUp();
    state.failing = new Error("the ledger is down");
    await copies.copy([forgotten("ana", 1)]);
    state.failing = fenceError({
      state: "frozen",
      tenant: DEFAULT_TENANT,
      since: NOW.toISOString(),
    });
    await copies.retry();
    state.failing = null;
    const appends = state.appends;
    await copies.retry();
    expect(state.appends).toBe(appends);
  });
});
