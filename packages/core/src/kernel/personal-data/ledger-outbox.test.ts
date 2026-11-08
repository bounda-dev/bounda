import { trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import {
  defineForgetLedger,
  FORGET_LEDGER_WAIT_MS,
  isForgetLedgerSource,
  openForgetLedger,
  waitForLedger,
} from "./forget-ledger.ts";
import { createLedgerOutbox, FORGET_LEDGER_SUBSCRIBER } from "./ledger-outbox.ts";

const span = trace.getTracer("test").startSpan("test");

const stored = (position: number, event: Parameters<typeof pendingEvent>[0]): StoredEvent => ({
  ...pendingEvent(event),
  position,
});

describe("the forget ledger's outbox", () => {
  it("appends only the runtime's PersonalDataForgotten, and all of a batch at once", async () => {
    const appended: (readonly ForgetLedgerEntry[])[] = [];
    const outbox = createLedgerOutbox({
      ledger: {
        append: async (entries) => {
          appended.push(entries);
        },
        read: async () => [],
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
      }),
    ];
    expect(await outbox.process(events, span)).toBe(5);
    expect(appended).toEqual([
      [
        { personId: "c-1", eventId: "f-1", forgottenAt: "2026-01-01T00:00:00.000Z" },
        { personId: "c-2", eventId: "f-2", forgottenAt: "2026-01-01T00:00:00.000Z" },
      ],
    ]);
    expect(await outbox.process(events.slice(0, 3), span)).toBe(3);
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
      [{ personId: "c-3", eventId: "f-3", forgottenAt: "2026-01-01T00:01:00.001Z" }],
    ]);
    expect(await outbox.process(events.slice(0, 2), span)).toBe(2);
    expect(appended).toHaveLength(1);
  });
});

describe("a forget ledger's source", () => {
  it("is an adapter that opens ledgers or a ledger definition, nothing else", () => {
    const definition = defineForgetLedger(() => ({ append: async () => {}, read: async () => [] }));
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
      return { append: async () => {}, read: async () => [] };
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
      { personId: "c-1", eventId: "e-1", forgottenAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(
      await (await adapter.createForgetLedger({ tenant: "t-1" })).read({ limit: 1 }),
    ).toHaveLength(1);
    expect(await (await adapter.createForgetLedger({})).read({ limit: 1 })).toEqual([]);
    expect(await openForgetLedger({ source: null, storage: memory(), env })).toBeNull();
  });

  it("refuses an adapter that points at the storage's own database", async () => {
    const storage = memory();
    const sqliteAt = (path: string) => ({ ...memory(), name: "sqlite", options: { path } });
    const app = sqliteAt("./data/app.db");
    for (const source of [storage, app, sqliteAt("./data/app.db")]) {
      await expect(
        openForgetLedger({ source, storage: source === storage ? storage : app, env: {} }),
      ).rejects.toThrow(
        "runtime.personalData.forgetLedger.store points at the storage's own database, which a restore rolls back with it: give it another database",
      );
    }
    expect(
      await openForgetLedger({
        source: sqliteAt("./ledger/forget-ledger.db"),
        storage: app,
        env: {},
      }),
    ).not.toBeNull();
    expect(
      await openForgetLedger({
        source: { ...memory(), name: "sqlite" },
        storage: { ...memory(), name: "postgresql" },
        env: {},
      }),
    ).not.toBeNull();
    expect(await openForgetLedger({ source: memory(), storage, env: {} })).not.toBeNull();
  });
});

describe("the wait for the forget ledger", () => {
  it("resolves what the ledger answers in time and lets its timer go, or late once it passes", async () => {
    const clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
    expect(await waitForLedger(clock, Promise.resolve(3))).toBe(3);
    expect(clock.pending()).toBe(0);
    await expect(waitForLedger(clock, Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(clock.pending()).toBe(0);
    const waiting = waitForLedger(clock, new Promise<never>(() => undefined));
    clock.advance(FORGET_LEDGER_WAIT_MS - 1);
    clock.advance(1);
    expect(await waiting).toBe("late");
  });
});
