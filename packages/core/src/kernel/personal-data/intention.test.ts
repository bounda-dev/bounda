import { describe, expect, it } from "vitest";
import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import { testPersonalKey } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ForgetLedgerUnavailableError } from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { memory } from "../../memory/index.ts";
import { createRecordingLogger } from "../test-support.ts";
import { type BoundedForgetLedger, boundForgetLedger } from "./forget-ledger.ts";
import { createForgetIntentions } from "./intention.ts";

const NOW = new Date("2026-03-01T00:00:00.000Z");

const setUp = async ({
  ledger,
  strict = false,
}: {
  readonly ledger: BoundedForgetLedger | null;
  readonly strict?: boolean;
}) => {
  const storage = await memory().createStorage();
  const { logger, entries: logs } = createRecordingLogger();
  const intentions = createForgetIntentions({
    ledger,
    strict,
    ids: createSequentialIdGenerator(),
    clock: createFixedClock(NOW),
    logger,
  });
  return { storage, intentions, logs };
};

const recordingLedger = (append: (entries: readonly ForgetLedgerEntry[]) => Promise<void>) =>
  boundForgetLedger({
    ledger: { append, read: async () => [] },
    timeoutMs: 1_000,
    clock: createFixedClock(NOW),
  });

describe("the intentions of forgetting", () => {
  it("record each in the ledger before they resolve, naming the key the person holds now", async () => {
    const appended: ForgetLedgerEntry[] = [];
    const { storage, intentions } = await setUp({
      ledger: recordingLedger(async (entries) => {
        appended.push(...entries);
      }),
    });
    await storage.personalKeys.add("c-1", testPersonalKey("1"));
    expect(
      await intentions.intend({ personId: "c-1", reason: "retention", keys: storage.personalKeys }),
    ).toEqual({
      eventId: "id-1",
      forgottenAt: NOW.toISOString(),
      reason: "retention",
      fingerprints: ["f-1"],
    });
    expect(
      await intentions.intend({ personId: "c-2", reason: "requested", keys: storage.personalKeys }),
    ).toMatchObject({ eventId: "id-2", fingerprints: [] });
    expect(appended).toEqual([
      {
        personId: "c-1",
        eventId: "id-1",
        forgottenAt: NOW.toISOString(),
        reason: "retention",
        fingerprints: ["f-1"],
      },
      {
        personId: "c-2",
        eventId: "id-2",
        forgottenAt: NOW.toISOString(),
        reason: "requested",
        fingerprints: [],
      },
    ]);
  });

  it("read no key and record nothing without a ledger, leaving any key to the forgetting", async () => {
    const { storage, intentions } = await setUp({ ledger: null });
    let reads = 0;
    const keys = {
      get: async (person: string) => {
        reads += 1;
        return storage.personalKeys.get(person);
      },
    };
    expect(await intentions.intend({ personId: "c-1", reason: "requested", keys })).toEqual({
      eventId: "id-1",
      forgottenAt: NOW.toISOString(),
      reason: "requested",
    });
    await intentions.record({
      personId: "c-1",
      eventId: "e-1",
      forgottenAt: NOW.toISOString(),
      reason: "requested",
    });
    expect(reads).toBe(0);
  });

  it("refuse, when strict, a forgetting the ledger does not take, with why", async () => {
    const down = new Error("ledger is down");
    const { storage, intentions } = await setUp({
      ledger: recordingLedger(async () => {
        throw down;
      }),
      strict: true,
    });
    const refused = intentions.intend({
      personId: "c-1",
      reason: "requested",
      keys: storage.personalKeys,
    });
    await expect(refused).rejects.toBeInstanceOf(ForgetLedgerUnavailableError);
    await expect(refused).rejects.toMatchObject({ cause: down });
  });

  it("log a forgetting the ledger does not take, when not strict, and let it go on", async () => {
    const { storage, intentions, logs } = await setUp({
      ledger: recordingLedger(async () => {
        throw new Error("ledger is down");
      }),
    });
    expect(
      await intentions.intend({ personId: "c-1", reason: "requested", keys: storage.personalKeys }),
    ).toMatchObject({ eventId: "id-1", fingerprints: [] });
    expect(logs).toEqual([
      {
        level: "warn",
        message: "forget ledger did not take the forgetting; it commits, and the stream copies it",
        fields: expect.objectContaining({ errorName: "Error", errorMessage: "ledger is down" }),
      },
    ]);
  });

  it("skip, when not strict, a ledger whose call given up for its timeout is still pending", async () => {
    let late = true;
    let appends = 0;
    const ledger: BoundedForgetLedger = {
      append: async () => {
        appends += 1;
      },
      read: async () => [],
      late: () => late,
    };
    const loose = await setUp({ ledger });
    await loose.intentions.intend({
      personId: "c-1",
      reason: "requested",
      keys: loose.storage.personalKeys,
    });
    expect(appends).toBe(0);
    const strict = await setUp({ ledger, strict: true });
    await strict.intentions.intend({
      personId: "c-1",
      reason: "requested",
      keys: strict.storage.personalKeys,
    });
    expect(appends).toBe(1);
    late = false;
    await loose.intentions.intend({
      personId: "c-1",
      reason: "requested",
      keys: loose.storage.personalKeys,
    });
    expect(appends).toBe(2);
  });
});
