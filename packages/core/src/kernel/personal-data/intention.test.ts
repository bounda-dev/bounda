import { describe, expect, it } from "vitest";
import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import { testPersonalKey } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import {
  ForgetLedgerUnavailableError,
  TenantForgottenError,
  TenantFrozenError,
} from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { memory } from "../../memory/index.ts";
import { disclosureEntryId } from "../shared/idempotency-key.ts";
import { createRecordingLogger } from "../test-support.ts";
import type { ForgetScope } from "./forget.ts";
import { type BoundedForgetLedger, boundForgetLedger } from "./forget-ledger.ts";
import { createForgetIntentions } from "./intention.ts";

const NOW = new Date("2026-03-01T00:00:00.000Z");

const WHOLE: ForgetScope = { kind: "whole" };

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
    ledger: ledger === null ? null : { store: ledger, strict },
    ids: createSequentialIdGenerator(),
    clock: createFixedClock(NOW),
    logger,
  });
  return { storage, intentions, logs };
};

const recordingLedger = (append: (entries: readonly ForgetLedgerEntry[]) => Promise<void>) =>
  boundForgetLedger({
    ledger: {
      append,
      read: async () => [],
      readMark: async () => 0,
      raiseMark: async () => undefined,
      clear: async () => true,
      fence: { read: async () => ({ state: "open" }), set: async (fence) => fence },
    },
    timeoutMs: 1_000,
    clock: createFixedClock(NOW),
  });

describe("the intentions of forgetting", () => {
  it("record each in the ledger before they resolve, naming the keys in force their scope covers", async () => {
    const appended: ForgetLedgerEntry[] = [];
    const { storage, intentions } = await setUp({
      ledger: recordingLedger(async (entries) => {
        appended.push(...entries);
      }),
    });
    await storage.personalKeys.add("c-1", "default", testPersonalKey("1"));
    await storage.personalKeys.add("c-1", "profile", testPersonalKey("2"));
    await storage.personalKeys.add("c-1", "invoices", testPersonalKey("3"));
    await storage.personalKeys.retain("c-1", "f-3", {
      since: NOW.toISOString(),
      lastActiveAt: NOW.toISOString(),
    });
    const intend = (personId: string, scope: ForgetScope) =>
      intentions.intend({ personId, reason: "retention", scope, keys: storage.personalKeys });
    expect(await intend("c-1", WHOLE)).toEqual({
      eventId: "id-1",
      forgottenAt: NOW.toISOString(),
      reason: "retention",
      fingerprints: ["f-1", "f-2"],
    });
    expect(await intend("c-2", WHOLE)).toMatchObject({ eventId: "id-2", fingerprints: [] });
    expect(
      await intend("c-1", { kind: "categories", categories: ["profile", "invoices"] }),
    ).toMatchObject({ fingerprints: ["f-2"] });
    expect(await intend("c-1", { kind: "keys", fingerprints: ["f-2", "f-3"] })).toMatchObject({
      fingerprints: ["f-2", "f-3"],
    });
    expect(appended).toEqual([
      {
        personId: "c-1",
        categories: null,
        eventId: "id-1",
        forgottenAt: NOW.toISOString(),
        reason: "retention",
        fingerprints: ["f-1", "f-2"],
        committed: false,
      },
      {
        personId: "c-2",
        categories: null,
        eventId: "id-2",
        forgottenAt: NOW.toISOString(),
        reason: "retention",
        fingerprints: [],
        committed: false,
      },
      {
        personId: "c-1",
        categories: ["profile", "invoices"],
        eventId: "id-3",
        forgottenAt: NOW.toISOString(),
        reason: "retention",
        fingerprints: ["f-2"],
        committed: false,
      },
      {
        personId: "c-1",
        categories: ["profile"],
        eventId: "id-4",
        forgottenAt: NOW.toISOString(),
        reason: "retention",
        fingerprints: ["f-2", "f-3"],
        committed: false,
      },
    ]);
  });

  it("name the keys an earlier forgetting kept of the categories an objection ends, and of no other", async () => {
    const appended: ForgetLedgerEntry[] = [];
    const { storage, intentions } = await setUp({
      ledger: recordingLedger(async (entries) => {
        appended.push(...entries);
      }),
    });
    await storage.personalKeys.add("c-1", "census", testPersonalKey("1"));
    await storage.personalKeys.add("c-1", "invoices", testPersonalKey("2"));
    await storage.personalKeys.add("c-1", "profile", testPersonalKey("3"));
    for (const fingerprint of ["f-1", "f-2"]) {
      await storage.personalKeys.retain("c-1", fingerprint, {
        since: NOW.toISOString(),
        lastActiveAt: NOW.toISOString(),
      });
    }
    expect(
      await intentions.intend({
        personId: "c-1",
        reason: "objection",
        scope: WHOLE,
        ends: (category) => category === "census",
        keys: storage.personalKeys,
      }),
    ).toMatchObject({ reason: "objection", fingerprints: ["f-1", "f-3"] });
    expect(appended).toMatchObject([{ reason: "objection", fingerprints: ["f-1", "f-3"] }]);
  });

  it("read no key and record nothing without a ledger, leaving any key to the forgetting", async () => {
    const { storage, intentions } = await setUp({ ledger: null });
    let reads = 0;
    const keys = {
      list: async (person: string) => {
        reads += 1;
        return storage.personalKeys.list(person);
      },
      predecessors: storage.personalKeys.predecessors,
    };
    expect(
      await intentions.intend({ personId: "c-1", reason: "requested", scope: WHOLE, keys }),
    ).toEqual({
      eventId: "id-1",
      forgottenAt: NOW.toISOString(),
      reason: "requested",
    });
    await intentions.record({
      personId: "c-1",
      categories: null,
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
      scope: WHOLE,
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
      await intentions.intend({
        personId: "c-1",
        reason: "requested",
        scope: WHOLE,
        keys: storage.personalKeys,
      }),
    ).toMatchObject({ eventId: "id-1", fingerprints: [] });
    expect(logs).toEqual([
      {
        level: "warn",
        message: "forget ledger did not take the forgetting; it commits, and the stream copies it",
        fields: expect.objectContaining({ errorName: "Error", errorMessage: "ledger is down" }),
      },
    ]);
  });

  it.each([true, false])(
    "refuse, strict or not (%s), a forgetting or a disclosure the ledger's fence refuses, with the fence's error",
    async (strict) => {
      const frozen = new TenantFrozenError("acme", "2026-03-01T00:00:00.000Z");
      const forgotten = new TenantForgottenError("acme", "2026-03-01T00:00:00.000Z");
      for (const refusal of [frozen, forgotten]) {
        const { storage, intentions, logs } = await setUp({
          strict,
          ledger: recordingLedger(async () => {
            throw refusal;
          }),
        });
        await expect(
          intentions.intend({
            personId: "c-1",
            reason: "requested",
            scope: WHOLE,
            keys: storage.personalKeys,
          }),
        ).rejects.toBe(refusal);
        await expect(
          intentions.disclose(
            [
              {
                person: "c-1",
                port: "customer.mailer",
                recipient: "Mailchimp",
                kind: "processor",
                country: "US",
                safeguard: null,
                category: "contact",
              },
            ],
            "2026-03-01T00:00:00.000Z",
          ),
        ).rejects.toBe(refusal);
        expect(logs).toEqual([]);
      }
    },
  );

  it("skip, when not strict, a ledger whose call given up for its timeout is still pending", async () => {
    let late = true;
    let appends = 0;
    const ledger: BoundedForgetLedger = {
      readMark: async () => 0,
      raiseMark: async () => undefined,
      clear: async () => true,
      fence: { read: async () => ({ state: "open" }), set: async (fence) => fence },
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
      scope: WHOLE,
      keys: loose.storage.personalKeys,
    });
    expect(appends).toBe(0);
    const strict = await setUp({ ledger, strict: true });
    await strict.intentions.intend({
      personId: "c-1",
      reason: "requested",
      scope: WHOLE,
      keys: strict.storage.personalKeys,
    });
    expect(appends).toBe(1);
    late = false;
    await loose.intentions.intend({
      personId: "c-1",
      reason: "requested",
      scope: WHOLE,
      keys: loose.storage.personalKeys,
    });
    expect(appends).toBe(2);
  });

  it("keep with each intention where the database stood, read only for a ledger asked, and none with a disclosure", async () => {
    const appended: ForgetLedgerEntry[] = [];
    let reads = 0;
    let late = false;
    const ledger: BoundedForgetLedger = {
      ...recordingLedger(async (entries) => {
        appended.push(...entries);
      }),
      late: () => late,
    };
    const storage = await memory().createStorage();
    const intentions = createForgetIntentions({
      ledger: { store: ledger, strict: false },
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(NOW),
      logger: createRecordingLogger().logger,
      reached: async () => {
        reads += 1;
        return { position: 7, generation: 2 };
      },
    });
    await intentions.intend({
      personId: "c-1",
      reason: "requested",
      scope: WHOLE,
      keys: storage.personalKeys,
    });
    expect(appended.map(({ reached }) => reached)).toEqual([{ position: 7, generation: 2 }]);
    late = true;
    await intentions.record({ ...appended[0], eventId: "e-2" } as ForgetLedgerEntry);
    expect(reads).toBe(1);
    late = false;
    await intentions.disclose(
      [
        {
          person: "c-1",
          port: "customer.mailer",
          recipient: "Mailchimp",
          kind: "processor",
          country: "US",
          safeguard: null,
          category: "contact",
        },
      ],
      NOW.toISOString(),
    );
    expect(reads).toBe(1);
    expect(appended.at(-1)).not.toHaveProperty("reached");
  });

  it("keep an intention without where the database stood when it cannot be read, and say so", async () => {
    const appended: ForgetLedgerEntry[] = [];
    const { logger, entries } = createRecordingLogger();
    const intentions = createForgetIntentions({
      ledger: {
        store: recordingLedger(async (written) => {
          appended.push(...written);
        }),
        strict: true,
      },
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(NOW),
      logger,
      reached: async () => {
        throw new Error("the mark could not be raised");
      },
    });
    await intentions.record({
      personId: "c-1",
      categories: null,
      eventId: "e-1",
      forgottenAt: NOW.toISOString(),
      reason: "requested",
    });
    expect(appended).toEqual([expect.objectContaining({ eventId: "e-1", committed: false })]);
    expect(appended[0]).not.toHaveProperty("reached");
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "where the database stood could not be kept with the intention",
        fields: expect.objectContaining({ errorName: "Error" }),
      }),
    );
  });

  it("record disclosures in the ledger under an id each, and only log a failure of a ledger that is not strict", async () => {
    const appended: ForgetLedgerEntry[] = [];
    const disclosure = {
      person: "c-1",
      port: "customer.mailer",
      recipient: "Mailchimp",
      kind: "processor",
      country: "US",
      safeguard: null,
      category: "contact",
    };
    const { intentions } = await setUp({
      ledger: recordingLedger(async (entries) => {
        appended.push(...entries);
      }),
    });
    await intentions.disclose([disclosure], NOW.toISOString());
    const { person: _, ...ledgered } = disclosure;
    expect(appended).toEqual([
      {
        personId: "c-1",
        categories: null,
        eventId: disclosureEntryId(disclosure),
        forgottenAt: NOW.toISOString(),
        reason: "requested",
        disclosure: ledgered,
        committed: false,
      },
    ]);
    expect(disclosureEntryId(disclosure)).toBe("f8d89ec8-eb75-5ec1-8312-46f9fc212492");
    expect(disclosureEntryId(disclosure)).not.toBe(
      disclosureEntryId({ ...disclosure, category: "profile" }),
    );
    const failing = await setUp({
      ledger: recordingLedger(async () => {
        throw new Error("down");
      }),
    });
    await failing.intentions.disclose([disclosure], NOW.toISOString());
    expect(failing.logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message:
          "forget ledger did not take the disclosure; a restore that loses it would not tell its recipient",
      }),
    );
    const strict = await setUp({
      ledger: recordingLedger(async () => {
        throw new Error("down");
      }),
      strict: true,
    });
    await expect(
      strict.intentions.disclose([disclosure], NOW.toISOString()),
    ).rejects.toBeInstanceOf(ForgetLedgerUnavailableError);
  });
});
