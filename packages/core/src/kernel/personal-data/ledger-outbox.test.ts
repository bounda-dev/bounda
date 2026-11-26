import { trace } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ForgetLedgerTimeoutError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import {
  boundForgetLedger,
  defineForgetLedger,
  isForgetLedgerSource,
  openForgetLedger,
  waitForLedger,
} from "./forget-ledger.ts";
import { createLedgerOutbox, FORGET_LEDGER_SUBSCRIBER, forgettingEntry } from "./ledger-outbox.ts";
import { DEFAULT_TENANT } from "./tenant-keys.ts";

const span = trace.getTracer("test").startSpan("test");

const stored = (position: number, event: Parameters<typeof pendingEvent>[0]): StoredEvent => ({
  ...pendingEvent(event),
  position,
});

const reached = {
  id: "e-1",
  aggregateType: "customer",
  aggregateId: "c-4",
  type: "CustomerRegistered",
  fields: ["email"],
};

describe("the forget ledger's outbox", () => {
  it("appends only the runtime's PersonalDataForgotten, changes of restrictions and redactions, and all of a batch at once", async () => {
    const appended: (readonly ForgetLedgerEntry[])[] = [];
    const outbox = createLedgerOutbox({
      ledger: {
        append: async (entries) => {
          appended.push(entries);
        },
        read: async () => [],
        readMark: async () => [],
        raiseMark: async () => undefined,
        clear: async () => true,
        fence: { read: async () => ({ state: "open" }), set: async (fence) => fence },
      },
      keepForMs: null,
      clock: createFixedClock(new Date("2030-01-01T00:00:00.000Z")),
    });
    expect(outbox).toMatchObject({ name: FORGET_LEDGER_SUBSCRIBER, kind: "forget-ledger" });
    const events = [
      stored(1, { aggregateId: "o-1", version: 1 }),
      stored(2, {
        aggregateType: "bounda",
        aggregateId: "c-1",
        version: 1,
        type: "ProcessingRestricted",
        id: "r-1",
      }),
      stored(3, { aggregateId: "o-2", version: 1, type: "PersonalDataForgotten", id: "x-1" }),
      stored(4, {
        aggregateType: "bounda",
        aggregateId: "c-1",
        version: 2,
        type: "PersonalDataForgotten",
        id: "f-1",
      }),
      stored(5, {
        aggregateType: "bounda",
        aggregateId: "c-2",
        version: 1,
        type: "PersonalDataForgotten",
        id: "f-2",
        payload: { whole: false, categories: ["profile"], retained: ["invoices"], expired: [] },
      }),
      stored(6, {
        aggregateType: "bounda",
        aggregateId: "c-3",
        version: 1,
        type: "PersonalDataForgotten",
        id: "f-3",
        payload: { whole: false, categories: [], retained: [], expired: ["invoices"] },
      }),
      stored(7, {
        aggregateType: "bounda",
        aggregateId: "c-4",
        version: 1,
        type: "PersonalDataRedacted",
        id: "d-1",
        payload: {
          personId: "c-4",
          events: [reached],
          categories: ["default"],
          cancelledCommands: [],
          removedDeadLetters: [],
        },
      }),
      stored(8, { aggregateId: "o-3", version: 1, type: "PersonalDataRedacted", id: "x-2" }),
    ];
    expect(events.map((event) => outbox.handles?.(event))).toEqual([
      false,
      true,
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(await outbox.process(events, span)).toBe(8);
    expect(appended).toEqual([
      [
        {
          personId: "c-1",
          categories: null,
          eventId: "r-1",
          forgottenAt: "2026-01-01T00:00:00.000Z",
          reason: "requested",
          restriction: { type: "ProcessingRestricted", payload: events[1]?.payload },
        },
        {
          personId: "c-1",
          categories: null,
          eventId: "f-1",
          forgottenAt: "2026-01-01T00:00:00.000Z",
          reason: "requested",
        },
        {
          personId: "c-2",
          categories: ["profile", "invoices"],
          eventId: "f-2",
          forgottenAt: "2026-01-01T00:00:00.000Z",
          reason: "requested",
        },
        {
          personId: "c-3",
          categories: [],
          eventId: "f-3",
          forgottenAt: "2026-01-01T00:00:00.000Z",
          reason: "requested",
        },
        {
          personId: "c-4",
          categories: null,
          eventId: "d-1",
          forgottenAt: "2026-01-01T00:00:00.000Z",
          reason: "requested",
          redaction: { events: [reached] },
        },
      ],
    ]);
    expect(
      await outbox.process(
        [events[0], events[2]].filter((event) => event !== undefined),
        span,
      ),
    ).toBe(2);
    expect(appended).toHaveLength(1);
  });

  it("leaves out the forgettings older than keepFor, which a prune would remove", async () => {
    const appended: (readonly ForgetLedgerEntry[])[] = [];
    const forgetting = (position: number, id: string, timestamp: string): StoredEvent => ({
      ...stored(position, {
        aggregateType: "bounda",
        aggregateId: `c-${position}`,
        version: 1,
        type: "PersonalDataForgotten",
        id,
      }),
      timestamp,
    });
    const outbox = createLedgerOutbox({
      ledger: {
        append: async (entries) => {
          appended.push(entries);
        },
        read: async () => [],
        readMark: async () => [],
        raiseMark: async () => undefined,
        clear: async () => true,
        fence: { read: async () => ({ state: "open" }), set: async (fence) => fence },
      },
      keepForMs: 60_000,
      clock: createFixedClock(new Date("2026-01-01T00:02:00.000Z")),
    });
    const events = [
      forgetting(1, "f-1", "2026-01-01T00:00:59.999Z"),
      forgetting(2, "f-2", "2026-01-01T00:01:00.000Z"),
      forgetting(3, "f-3", "2026-01-01T00:01:00.001Z"),
    ];
    expect(await outbox.process(events, span)).toBe(3);
    expect(appended).toEqual([
      [
        {
          personId: "c-3",
          categories: null,
          eventId: "f-3",
          forgottenAt: "2026-01-01T00:01:00.001Z",
          reason: "requested",
        },
      ],
    ]);
    expect(await outbox.process(events.slice(0, 2), span)).toBe(2);
    expect(appended).toHaveLength(1);
  });
});

describe("a forgetting's entry", () => {
  const forgetting = (payload: unknown): StoredEvent => ({
    ...stored(4, {
      aggregateType: "bounda",
      aggregateId: "c-1",
      version: 1,
      type: "PersonalDataForgotten",
      id: "f-1",
    }),
    payload,
  });

  it("carries the reason and the keys its event names, as its intention wrote them", () => {
    expect(
      forgettingEntry(forgetting({ personId: "c-1", reason: "retention", fingerprints: ["k-1"] })),
    ).toEqual({
      personId: "c-1",
      categories: null,
      eventId: "f-1",
      forgottenAt: "2026-01-01T00:00:00.000Z",
      reason: "retention",
      fingerprints: ["k-1"],
    });
    expect(forgettingEntry(forgetting({ reason: "requested", fingerprints: [] }))).toMatchObject({
      reason: "requested",
      fingerprints: [],
    });
  });

  it("reads as a request naming no keys what an earlier event did not record", () => {
    for (const payload of [
      {},
      null,
      "text",
      { reason: "restored", fingerprints: "k-1" },
      { reason: 3, fingerprints: ["k-1", 2] },
    ]) {
      const entry = forgettingEntry(forgetting(payload));
      expect(entry.reason).toBe("requested");
      expect(entry).not.toHaveProperty("fingerprints");
    }
  });
});

describe("a forget ledger's source", () => {
  it("is an adapter that opens ledgers or a ledger definition, nothing else", () => {
    const definition = defineForgetLedger(() => ({
      append: async () => {},
      read: async () => [],
      readMark: async () => [],
      raiseMark: async () => undefined,
      clear: async () => true,
      fence: { read: async () => ({ state: "open" }), set: async (fence) => fence },
    }));
    expect(isForgetLedgerSource(memory())).toBe(true);
    expect(isForgetLedgerSource(definition)).toBe(true);
    for (const value of [
      null,
      "ledger.db",
      { kind: "bounda-adapter", name: "cloudflare", options: {} },
      { kind: "elsewhere", createForgetLedger: () => undefined },
      { kind: "bounda-forget-ledger" },
    ]) {
      expect(isForgetLedgerSource(value)).toBe(false);
    }
  });

  it("opens a definition with the host's environment and the tenant, and an adapter with the tenant", async () => {
    const seen: unknown[] = [];
    const definition = defineForgetLedger((args) => {
      seen.push(args);
      return {
        append: async () => {},
        read: async () => [],
        readMark: async () => [],
        raiseMark: async () => undefined,
        clear: async () => true,
        fence: { read: async () => ({ state: "open" }), set: async (fence) => fence },
      };
    });
    const env = { REGION: "eu" };
    await openForgetLedger({ source: definition, storage: memory(), env, tenant: "t-1" });
    expect(seen).toEqual([{ env, tenant: "t-1" }]);
    const adapter = memory();
    const ledger = await openForgetLedger({
      source: adapter,
      storage: memory(),
      env,
      tenant: "t-1",
    });
    await ledger?.append([
      {
        personId: "c-1",
        categories: null,
        eventId: "e-1",
        forgottenAt: "2026-01-01T00:00:00.000Z",
        reason: "requested",
      },
    ]);
    expect(
      await (await adapter.createForgetLedger({ tenant: "t-1" })).read({ limit: 1 }),
    ).toHaveLength(1);
    expect(
      await (await adapter.createForgetLedger({ tenant: DEFAULT_TENANT })).read({ limit: 1 }),
    ).toEqual([]);
  });

  it("refuses an adapter that points at the storage's own database", async () => {
    const storage = memory();
    const sqliteAt = (path: string) => ({ ...memory(), name: "sqlite", options: { path } });
    const app = sqliteAt("./data/app.db");
    for (const source of [storage, app, sqliteAt("./data/app.db")]) {
      await expect(
        openForgetLedger({
          source,
          storage: source === storage ? storage : app,
          env: {},
          tenant: DEFAULT_TENANT,
        }),
      ).rejects.toThrow(
        "runtime.personalData.forgetLedger.store points at the storage's own database, which a restore rolls back with it: give it another database",
      );
    }
    expect(
      await openForgetLedger({
        source: sqliteAt("./ledger/forget-ledger.db"),
        storage: app,
        env: {},
        tenant: DEFAULT_TENANT,
      }),
    ).not.toBeNull();
    expect(
      await openForgetLedger({
        source: { ...memory(), name: "sqlite" },
        storage: { ...memory(), name: "postgresql" },
        env: {},
        tenant: DEFAULT_TENANT,
      }),
    ).not.toBeNull();
    expect(
      await openForgetLedger({ source: memory(), storage, env: {}, tenant: DEFAULT_TENANT }),
    ).not.toBeNull();
  });
});

describe("the wait for the forget ledger", () => {
  it("resolves what the ledger answers in time and lets its timer go, or late once it passes", async () => {
    const clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
    expect(await waitForLedger(clock, 500, Promise.resolve(3))).toBe(3);
    expect(clock.pending()).toBe(0);
    await expect(waitForLedger(clock, 500, Promise.reject(new Error("down")))).rejects.toThrow(
      "down",
    );
    expect(clock.pending()).toBe(0);
    let settled: unknown;
    void waitForLedger(clock, 500, new Promise<never>(() => undefined)).then((outcome) => {
      settled = outcome;
    });
    clock.advance(499);
    await Promise.resolve();
    expect(settled).toBeUndefined();
    clock.advance(1);
    await vi.waitFor(() => expect(settled).toBe("late"));
  });
});

describe("the forget ledger bound by its timeout", () => {
  const entry = {
    personId: "c-1",
    categories: null,
    eventId: "e-1",
    forgottenAt: "2026-01-01T00:00:00.000Z",
    reason: "requested" as const,
  };

  it("passes every call through, its delay and close included, and lets each timer go", async () => {
    const clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const calls: string[] = [];
    const ledger = boundForgetLedger({
      ledger: {
        visibilityDelayMs: 60_000,
        readMark: async (name) => {
          calls.push(`readMark ${name}`);
          return [{ value: 7, raisedAt: "2026-01-01T00:00:00.000Z" }];
        },
        raiseMark: async (name, { value }) => {
          calls.push(`raiseMark ${name} ${value}`);
        },
        pruneMarks: async (name, before) => {
          calls.push(`pruneMarks ${name} ${before}`);
        },
        clear: async () => {
          calls.push("clear");
          return true;
        },
        fence: {
          read: async () => {
            calls.push("fence.read");
            return { state: "open" };
          },
          set: async (fence) => {
            calls.push(`fence.set ${fence.state}`);
            return fence;
          },
        },
        append: async (entries) => {
          calls.push(`append ${entries.length}`);
        },
        read: async ({ limit }) => {
          calls.push(`read ${limit}`);
          return [entry];
        },
        prune: async ({ before }) => {
          calls.push(`prune ${before}`);
        },
        close: async () => {
          calls.push("close");
        },
      },
      timeoutMs: 500,
      clock,
    });
    await ledger.append([entry]);
    expect(await ledger.read({ limit: 3 })).toEqual([entry]);
    await ledger.prune?.({ before: "t" });
    expect(await ledger.readMark("m")).toEqual([
      { value: 7, raisedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await ledger.raiseMark("m", { value: 8, raisedAt: "2026-01-01T00:00:00.000Z" });
    await ledger.pruneMarks?.("m", "t");
    await ledger.clear();
    await ledger.close?.();
    expect(calls).toEqual([
      "append 1",
      "read 3",
      "prune t",
      "readMark m",
      "raiseMark m 8",
      "pruneMarks m t",
      "clear",
      "close",
    ]);
    expect(ledger.visibilityDelayMs).toBe(60_000);
    expect(ledger.late()).toBe(false);
    expect(clock.pending()).toBe(0);
    const bare = boundForgetLedger({
      ledger: {
        append: async () => {},
        read: async () => [],
        readMark: async () => [],
        raiseMark: async () => undefined,
        clear: async () => true,
        fence: { read: async () => ({ state: "open" }), set: async (fence) => fence },
      },
      timeoutMs: 500,
      clock,
    });
    expect(bare).not.toHaveProperty("visibilityDelayMs");
    expect(bare).not.toHaveProperty("prune");
    expect(bare).not.toHaveProperty("pruneMarks");
    expect(bare).not.toHaveProperty("close");
  });

  it("gives a call up at its timeout, and says it is late until that call settles", async () => {
    const clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
    let answer: () => void = () => undefined;
    const never = () => new Promise<never>(() => undefined);
    const ledger = boundForgetLedger({
      ledger: {
        readMark: never,
        raiseMark: never,
        pruneMarks: never,
        clear: never,
        fence: { read: never, set: never },
        append: () =>
          new Promise<void>((resolve) => {
            answer = resolve;
          }),
        read: () => Promise.reject(new Error("down")),
        prune: () => new Promise<void>(() => undefined),
      },
      timeoutMs: 500,
      clock,
    });
    const appending = ledger.append([entry]);
    clock.advance(499);
    expect(ledger.late()).toBe(false);
    clock.advance(1);
    await expect(appending).rejects.toEqual(new ForgetLedgerTimeoutError("append", 500));
    expect(ledger.late()).toBe(true);
    answer();
    await vi.waitFor(() => expect(ledger.late()).toBe(false));
    await expect(ledger.read({ limit: 1 })).rejects.toThrow("down");
    expect(ledger.late()).toBe(false);
    const pruning = ledger.prune?.({ before: "t" });
    clock.advance(500);
    await expect(pruning).rejects.toMatchObject({ operation: "prune", timeoutMs: 500 });
    const marking = [
      ledger.readMark("m"),
      ledger.raiseMark("m", { value: 1, raisedAt: "2026-01-01T00:00:00.000Z" }),
      ledger.pruneMarks?.("m", "t"),
      ledger.clear(),
    ];
    clock.advance(500);
    for (const [index, operation] of ["readMark", "raiseMark", "pruneMarks", "clear"].entries()) {
      await expect(marking[index]).rejects.toEqual(new ForgetLedgerTimeoutError(operation, 500));
    }
  });
});
