import { trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import { defineForgetLedger, isForgetLedgerSource, openForgetLedger } from "./forget-ledger.ts";
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
      append: async (entries) => {
        appended.push(entries);
      },
      read: async () => [],
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
    await openForgetLedger({ source: definition, env, tenant: "t-1" });
    expect(seen).toEqual([{ env, tenant: "t-1" }]);
    const adapter = memory();
    const ledger = await openForgetLedger({ source: adapter, env, tenant: "t-1" });
    await ledger?.append([
      { personId: "c-1", eventId: "e-1", forgottenAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(
      await (await adapter.createForgetLedger({ tenant: "t-1" })).read({ limit: 1 }),
    ).toHaveLength(1);
    expect(await (await adapter.createForgetLedger({})).read({ limit: 1 })).toEqual([]);
    expect(await openForgetLedger({ source: null, env })).toBeNull();
  });
});
