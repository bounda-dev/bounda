import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createSqliteAdapter } from "@bounda-dev/core/adapter/sqlite";
import { expectForgotten } from "@bounda-dev/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { durableObjectAdapter } from "../src/adapter.ts";
import { configForObject, createBoundaObject } from "../src/bounda-object.ts";
import { connect } from "../src/client.ts";
import { cloudflare } from "../src/definition.ts";
import {
  outage,
  type processRegistry,
  quietRegistry,
  type registry,
  type slicedRegistry,
} from "./app.ts";
import { clock } from "./clock.ts";
import { logs, recordingLogger } from "./logs.ts";
import { QuietStore } from "./test-worker.ts";

const fresh = () => env.STORE.get(env.STORE.newUniqueId());

const alarmOf = (stub: ReturnType<typeof fresh>) =>
  runInDurableObject(stub as unknown as DurableObjectStub, (_instance, state) =>
    state.storage.getAlarm(),
  );

// An alarm already due is one the runtime is running on its own, and its handler clears or re-arms
// it when done; only a later one, or none, is the object's settled answer.
const settledAlarm = async (stub: ReturnType<typeof fresh>) => {
  for (;;) {
    const at = await alarmOf(stub);
    if (at === null || at > Date.now()) return at;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// The object arms its alarm for now after a request, so the runtime may fire it on its own before
// `runDurableObjectAlarm` looks, which then runs nothing and returns while that alarm is still
// under way. The handler called inside the object returns once the work is done, whichever ran it.
const runAlarm = <O extends Rpc.DurableObjectBranded & { alarm(): Promise<void> }>(
  stub: DurableObjectStub<O>,
) => runInDurableObject(stub, (instance) => instance.alarm());

const rejection = async (
  pending: Promise<unknown>,
): Promise<Error & { readonly code?: string }> => {
  try {
    await pending;
  } catch (error) {
    return error as Error & { readonly code?: string };
  }
  throw new Error("expected a rejection");
};

const open = (stub = fresh()) => ({ stub, store: connect<typeof registry>(stub) });

const sliced = () => env.SLICED_STORE.get(env.SLICED_STORE.newUniqueId());

// What the object itself logs about its rebuilds and alarms, apart from the app's own entries.
const objectLogs = (entries: readonly unknown[][]) =>
  entries.filter(([message]) => /^bounda (rebuild|alarm)/.test(String(message)));

// Runs alarms until the walk over what was written before the personal data marks has caught up,
// so a test of what an alarm wakes for next sees nothing else due.
const backfilled = async (instance: {
  lag(): Promise<{ ok: boolean; value?: { personalDataBackfill: { caughtUp: boolean } | null } }>;
  alarm(): Promise<void>;
}): Promise<void> => {
  for (;;) {
    const lag = await instance.lag();
    if (lag.value?.personalDataBackfill?.caughtUp !== false) return;
    await instance.alarm();
  }
};

beforeEach(() => {
  logs.info.length = 0;
  logs.error.length = 0;
});

afterEach(() => {
  outage.archive = true;
  outage.projection = false;
});

describe("a Bounda Durable Object", () => {
  it("stores a command and answers the next query with it", async () => {
    const { store } = open();
    const placed = await store.commands.placeOrder({ orderId: "o-1", total: 42, customer: "ada" });
    expect(placed).toMatchObject({ scheduled: false, aggregateId: "o-1", version: 1 });
    expect(await store.queries.getOrder({ orderId: "o-1" })).toEqual({
      orderId: "o-1",
      status: "placed",
      total: 42,
    });
  });

  it("seals personal fields in its SQLite, projects them in the clear, and forgets a person", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada", note: "no bell" });
    expect(await store.queries.getOrder({ orderId: "o-1" })).toMatchObject({ note: "no bell" });
    const [raw] = await store.events.read();
    expect(raw?.payload).toMatchObject({ total: 7, customer: "ada" });
    expect(JSON.stringify(raw)).not.toContain("no bell");
    const sealed = await runInDurableObject(stub as unknown as DurableObjectStub, (_i, state) =>
      state.storage.sql.exec(`SELECT "person" FROM bounda_personal_keys`).toArray(),
    );
    expect(sealed).toEqual([{ person: "ada" }]);

    const before = await store.exportPersonalData("ada");
    const forgotten = await store.forget("ada");
    expect(forgotten).toMatchObject({
      aggregateType: "bounda",
      aggregateId: "ada",
      eventTypes: ["PersonalDataForgotten"],
      position: 2,
    });
    expect((await store.events.read()).map((event) => event.type)).toEqual([
      "OrderPlaced",
      "PersonalDataForgotten",
    ]);
    expect(await store.rebuildReadModel("orders")).toMatchObject({ done: true });
    expect(await store.queries.getOrder({ orderId: "o-1" })).toEqual({
      orderId: "o-1",
      status: "placed",
      total: 7,
    });
    const search = (values: readonly unknown[] = []) =>
      runInDurableObject(stub as unknown as DurableObjectStub, (_i, state) =>
        expectForgotten(durableObjectAdapter({ storage: state.storage }), "ada", {
          before,
          values,
          places: { logs: logs.info, errors: logs.error },
        }).catch((error: unknown) => error),
      );
    expect(await search()).toBeUndefined();
    expect(await search(["7"])).toMatchObject({
      name: "NotForgottenError",
      found: expect.arrayContaining([
        { value: "7", store: "bounda_events", row: "position=1", field: "payload.total" },
      ]),
    });
  });

  it("exports a person's marked fields from its SQLite, before and after forgetting them", async () => {
    const { store } = open();
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada", note: "no bell" });
    const before = await store.exportPersonalData("ada");
    expect(before).toMatchObject({ personId: "ada", scheduledCommands: [], deadLetters: [] });
    expect(before.events).toEqual([
      expect.objectContaining({ type: "OrderPlaced", position: 1, data: { note: "no bell" } }),
    ]);
    await store.forget("ada");
    const after = await store.exportPersonalData("ada");
    expect(after.events.map((event) => [event.type, event.data])).toEqual([
      ["OrderPlaced", { note: null }],
      ["PersonalDataForgotten", {}],
    ]);
    const refused = await rejection(store.exportPersonalData(""));
    expect(refused).toMatchObject({ name: "ValidationError", code: "VALIDATION_FAILED" });
  });

  it("restricts a person's processing, refusing their commands, and lifts it, arming the alarm that retries what was refused", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada" });
    const restricted = await store.restrict("ada", { ground: "accuracy-contested" });
    expect(restricted).toMatchObject({
      aggregateType: "bounda",
      aggregateId: "ada",
      eventTypes: ["ProcessingRestricted"],
      position: 2,
    });
    const refused = await store.commands
      .placeOrder({ orderId: "o-2", total: 3, customer: "ada" })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: "PROCESSING_RESTRICTED",
      message: "The processing of this person's data is restricted",
    });
    expect(
      (await store.commands.placeOrder({ orderId: "o-3", total: 3, customer: "bo" })).eventTypes,
    ).toEqual(["OrderPlaced"]);

    // In one event of the object, so its alarm cannot run between the lift and the look.
    const lifted = await runInDurableObject(stub, async (instance, state) => ({
      outcome: await instance.unrestrict("ada", undefined, undefined, { notice: "given" }),
      alarm: await state.storage.getAlarm(),
    }));
    expect(lifted.outcome).toMatchObject({
      ok: true,
      value: { eventTypes: ["ProcessingRestrictionLifted"], position: 4 },
    });
    expect(lifted.alarm).toBeLessThanOrEqual(Date.now());
    await runAlarm(stub);
    expect(await alarmOf(stub)).toBeNull();
    expect(
      (await store.commands.placeOrder({ orderId: "o-2", total: 3, customer: "ada" })).eventTypes,
    ).toEqual(["OrderPlaced"]);
    expect((await store.events.read()).map((event) => event.type)).toEqual([
      "OrderPlaced",
      "ProcessingRestricted",
      "OrderPlaced",
      "ProcessingRestrictionLifted",
      "OrderPlaced",
    ]);
  });

  it("forgets with the caller's consistency, and leaves its alarm clear once the read models caught up", async () => {
    const stub = sliced();
    const store = connect<typeof slicedRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 5, customer: "ada" });
    await store.commands.placeOrder({ orderId: "o-2", total: 5, customer: "bo" });
    // In one event of the object, its alarm cannot run between the forget and the query.
    const seen = await runInDurableObject(stub, async (instance, state) => ({
      forgotten: await instance.forget("ada", "eventual"),
      found: await instance.query("getCustomer", { customer: "ada" }),
      alarm: await state.storage.getAlarm(),
    }));
    expect(seen.forgotten).toMatchObject({ ok: true, value: { aggregateId: "ada", version: 1 } });
    expect(seen.found).toEqual({ ok: true, value: { customer: "ada", lastOrderId: "o-1" } });
    expect(seen.alarm).toBeLessThanOrEqual(Date.now());
    await runAlarm(stub);
    expect(await store.queries.getCustomer({ customer: "ada" })).toBeNull();

    // Under read-your-writes the forget waits for the read models that handle it; the others
    // catch up in the alarm, which is armed for them.
    const forgotten = await runInDurableObject(stub, async (instance, state) => ({
      outcome: await instance.forget("bo"),
      found: await instance.query("getCustomer", { customer: "bo" }),
      lag: await instance.lag(),
      alarm: await state.storage.getAlarm(),
    }));
    expect(forgotten.outcome).toMatchObject({ ok: true, value: { aggregateId: "bo", version: 1 } });
    expect(forgotten.found).toEqual({ ok: true, value: null });
    expect(forgotten.lag).toMatchObject({
      ok: true,
      value: {
        subscribers: expect.arrayContaining([
          expect.objectContaining({ subscriber: "projection:customers", lag: 0 }),
          expect.objectContaining({ subscriber: "projection:orders", lag: 1 }),
        ]),
      },
    });
    expect(forgotten.alarm).toBeLessThanOrEqual(Date.now());
    await runAlarm(stub);
    expect((await store.getLag()).maxLag).toBe(0);
    expect(await settledAlarm(stub)).toBeNull();
  });

  it("checks a command's signal before calling the object, which cannot receive it", async () => {
    const { store } = open();
    const reason = new Error("client gave up");
    await expect(
      store.commands.placeOrder(
        { orderId: "o-1", total: 42, customer: "ada" },
        { signal: AbortSignal.abort(reason) },
      ),
    ).rejects.toBe(reason);
    const placed = await store.commands.placeOrder(
      { orderId: "o-1", total: 42, customer: "ada" },
      { signal: new AbortController().signal },
    );
    expect(placed).toMatchObject({ scheduled: false, aggregateId: "o-1", version: 1 });
  });

  it("leaves policies to its alarm and clears the alarm once nothing is pending", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "o-1", total: 42, customer: "ada" });
    const paid = await store.commands.payOrder({ orderId: "o-1" });
    expect(paid).toMatchObject({ scheduled: false, version: 2 });
    await runAlarm(stub);
    expect(await store.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "archived" });
    expect((await store.getLag()).maxLag).toBe(0);
    expect(await settledAlarm(stub)).toBeNull();
  });

  it("arms no alarm after a command when the app has no policies or processes", async () => {
    const stub = env.QUIET_STORE.get(env.QUIET_STORE.newUniqueId());
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 42, customer: "ada" });
    expect(await store.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "placed" });
    expect((await store.getLag()).maxLag).toBe(0);
    expect(await settledAlarm(stub)).toBeNull();
  });

  it("arms its alarm for a person's retention deadline and forgets them when it comes", async () => {
    const stub = env.RETAINED_STORE.get(env.RETAINED_STORE.newUniqueId());
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 42, customer: "ada", note: "ring" });
    await runAlarm(stub);
    const before = Date.now();
    const armed = await settledAlarm(stub);
    expect(armed).toBeGreaterThanOrEqual(before + 3_600_000 - 1_000);
    expect(armed).toBeLessThanOrEqual(Date.now() + 3_600_000 + 1_000);

    clock.advance(3_600_000);
    await runAlarm(stub);
    const forgotten = (await store.events.read()).filter(
      (event) => event.type === "PersonalDataForgotten",
    );
    expect(forgotten.map((event) => event.payload)).toMatchObject([
      { personId: "ada", reason: "retention" },
    ]);
    const keys = await runInDurableObject(stub as unknown as DurableObjectStub, (_i, state) =>
      state.storage.sql.exec(`SELECT "person" FROM bounda_personal_keys`).toArray(),
    );
    expect(keys).toEqual([]);
    expect(await settledAlarm(stub)).toBeNull();
  });

  it("wraps its personal keys under the master key in the Worker's secret, and opens them back", async () => {
    const stub = env.WRAPPED_STORE.get(env.WRAPPED_STORE.newUniqueId());
    const store = connect<typeof quietRegistry>(stub);
    // Started first, so the master key is read and imported before the watch begins.
    await store.exportPersonalData("nobody");
    const exported = vi.spyOn(crypto.subtle, "exportKey");
    const imported = vi.spyOn(crypto.subtle, "importKey");
    const sealed = vi.spyOn(crypto.subtle, "encrypt");
    await store.commands.placeOrder({ orderId: "o-1", total: 42, customer: "ada", note: "ring" });
    expect((await store.exportPersonalData("ada")).events.map((event) => event.data)).toEqual([
      { note: "ring" },
    ]);
    // The watch sees inside the object, which sealed the note, yet the person's raw key never
    // reached JavaScript there.
    expect(sealed).toHaveBeenCalled();
    expect(exported).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const rows = await runInDurableObject(stub as unknown as DurableObjectStub, (_i, state) =>
      state.storage.sql
        .exec(`SELECT "person", "key", "fingerprint", "kid" FROM bounda_personal_keys`)
        .toArray(),
    );
    const bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    const master = bytes(env.BOUNDA_MASTER_KEY);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", master));
    const kid = btoa(String.fromCharCode(...digest.slice(0, 12)))
      .replaceAll("+", "-")
      .replaceAll("/", "_");
    expect(rows).toEqual([
      { person: "ada", key: expect.any(String), fingerprint: expect.any(String), kid },
    ]);
    const [row] = rows as { key: string; fingerprint: string }[];
    // Unwrapped by WebCrypto straight into a key that can never be exported, and checked by the
    // AES-GCM tag of nothing under the all-zero nonce, as the runtime fingerprints it.
    const wrapping = await crypto.subtle.importKey("raw", master, "AES-KW", false, ["unwrapKey"]);
    const key = await crypto.subtle.unwrapKey(
      "raw",
      bytes(row?.key ?? ""),
      wrapping,
      "AES-KW",
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    const tag = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: new Uint8Array(12) },
        key,
        new Uint8Array(),
      ),
    );
    expect(btoa(String.fromCharCode(...tag))).toBe(row?.fingerprint);
    expect((await store.exportPersonalData("ada")).events.map((event) => event.data)).toEqual([
      { note: "ring" },
    ]);
  });

  it("answers an eventual command once its events are stored and projects them in its alarm", async () => {
    const stub = env.QUIET_STORE.get(env.QUIET_STORE.newUniqueId());
    const before = Date.now();
    // In one event of the object, its alarm cannot run between the command and the query.
    const seen = await runInDurableObject(stub, async (instance, state) => ({
      placed: await instance.command(
        "placeOrder",
        { orderId: "o-1", total: 42, customer: "ada" },
        undefined,
        "eventual",
      ),
      found: await instance.query("getOrder", { orderId: "o-1" }),
      alarm: await state.storage.getAlarm(),
    }));
    expect(seen.placed).toMatchObject({ ok: true, value: { scheduled: false, version: 1 } });
    expect(seen.found).toEqual({ ok: true, value: null });
    expect(seen.alarm).toBeGreaterThanOrEqual(before);
    expect(seen.alarm).toBeLessThanOrEqual(Date.now());

    await runAlarm(stub);
    const store = connect<typeof quietRegistry>(stub);
    expect(await store.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "placed" });
    expect((await store.getLag()).maxLag).toBe(0);
    expect(await settledAlarm(stub)).toBeNull();
  });

  it("arms its alarm for a scheduled command and runs it once the clock gets there", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "o-2", total: 7, customer: "ada" });
    await runAlarm(stub);
    const before = Date.now();
    const scheduled = await store.commands.archiveOrder({ orderId: "o-2" }, { delay: "10m" });
    expect(scheduled).toMatchObject({ scheduled: true });
    const armed = await alarmOf(stub);
    expect(armed).toBeGreaterThanOrEqual(before + 600_000 - 1_000);
    expect(armed).toBeLessThanOrEqual(Date.now() + 600_000 + 1_000);

    await runAlarm(stub);
    expect(await store.queries.getOrder({ orderId: "o-2" })).toMatchObject({ status: "placed" });
    clock.advance(600_000);
    await runAlarm(stub);
    expect(await store.queries.getOrder({ orderId: "o-2" })).toMatchObject({ status: "archived" });
    expect(await settledAlarm(stub)).toBeNull();
  });

  it("runs a process step, its deadline and the policy after it, each committed whole in the object", async () => {
    const stub = env.PROCESS_STORE.get(env.PROCESS_STORE.newUniqueId());
    const store = connect<typeof processRegistry>(stub);
    const lifecycle = () =>
      runInDurableObject(stub as unknown as DurableObjectStub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT "type" FROM "bounda_events" WHERE "aggregate_type" = 'process:order.settlement' ORDER BY "position"`,
          )
          .toArray()
          .map((row) => row.type),
      );
    const before = Date.now();
    await store.commands.placeOrder({ orderId: "o-1", total: 42, customer: "ada" });
    await runAlarm(stub);
    expect(await lifecycle()).toEqual(["ProcessStarted", "ProcessHandled"]);
    const armed = await alarmOf(stub);
    expect(armed).toBeGreaterThanOrEqual(before + 3_600_000 - 1_000);
    expect(armed).toBeLessThanOrEqual(Date.now() + 3_600_000 + 1_000);

    clock.advance(3_600_000);
    await runAlarm(stub);
    expect(await store.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "archived" });
    expect(await lifecycle()).toEqual([
      "ProcessStarted",
      "ProcessHandled",
      "ProcessDeadlineReached",
      "ProcessCompleted",
    ]);
    expect((await store.getLag()).maxLag).toBe(0);
    expect(await settledAlarm(stub)).toBeNull();
  });

  it("reads its global stream by position, process lifecycle events included", async () => {
    const stub = env.PROCESS_STORE.get(env.PROCESS_STORE.newUniqueId());
    const store = connect<typeof processRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 42, customer: "ada" });
    await runAlarm(stub);

    const events = await store.events.read();
    expect(events.map((event) => [event.position, event.aggregateType, event.type])).toEqual([
      [1, "order", "OrderPlaced"],
      [2, "process:order.settlement", "ProcessStarted"],
      [3, "process:order.settlement", "ProcessHandled"],
    ]);
    expect(events[0]).toMatchObject({
      aggregateId: "o-1",
      payload: { total: 42, customer: "ada" },
      metadata: { schemaVersion: 1, system: false },
    });
    expect(events[2]?.metadata.causationId).toBe(events[0]?.id);
    expect(await store.events.read({ after: 1, limit: 1 })).toEqual(events.slice(1, 2));
    const refused = await rejection(store.events.read({ limit: 1_001 }));
    expect(refused).toMatchObject({ name: "ValidationError", code: "VALIDATION_FAILED" });
    expect(Reflect.get(refused, "issues")).toEqual([
      { path: ["limit"], message: "Expected a whole number from 1 to 1000" },
    ]);
  });

  it("returns the domain's refusals and names what it does not know", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "o-3", total: 1, customer: "ada" });
    const refused = await rejection(
      store.commands.placeOrder({ orderId: "o-3", total: 1, customer: "ada" }),
    );
    expect(refused).toMatchObject({
      name: "DomainError",
      message: "Order already placed",
      rejected: "AlreadyPlaced",
    });
    expect(refused.code).toBe("DOMAIN_ERROR");
    expect(await stub.command("nope")).toEqual({
      ok: false,
      refusal: { name: "NotFoundError", message: 'Unknown command "nope"', code: "NOT_FOUND" },
    });
    const unknownQuery = Reflect.get(store.queries, "nope") as (
      payload: unknown,
    ) => Promise<unknown>;
    expect(await rejection(unknownQuery({}))).toMatchObject({
      name: "NotFoundError",
      message: 'Unknown query "nope"',
      code: "NOT_FOUND",
    });
    const invalid = await rejection(store.commands.placeOrder({ orderId: "o-9" } as never));
    expect(invalid).toMatchObject({ name: "ValidationError", code: "VALIDATION_FAILED" });
    expect(Reflect.get(invalid, "issues")).toEqual(expect.arrayContaining([expect.any(Object)]));
  });

  it("acts as the actor connect(...).as() sends, on the events of its commands and of forget", async () => {
    const { stub, store } = open();
    const user = store.as("user-1");
    await user.commands.placeOrder({ orderId: "o-1", total: 42, customer: "ada" });
    await store.as("dpo-1").forget("ada");
    await store.commands.placeOrder({ orderId: "o-2", total: 1, customer: "bob" });
    const actors = (await store.events.read()).map((event) => [
      event.type,
      event.metadata.actor ?? null,
    ]);
    expect(actors).toEqual([
      ["OrderPlaced", "user-1"],
      ["PersonalDataForgotten", "dpo-1"],
      ["OrderPlaced", null],
    ]);
    expect(await stub.command("placeOrder", {}, undefined, undefined, "")).toMatchObject({
      ok: false,
      refusal: { code: "VALIDATION_FAILED" },
    });
  });

  it("reports its status and keeps a projection's last failure, opened through a recorded call", async () => {
    const { store } = open();
    outage.projection = true;
    await store.commands.placeOrder({ orderId: "o-1", total: 5, customer: "ada", note: "x" });
    outage.projection = false;
    const status = await store.status();
    expect(status.schema).toEqual([
      { database: "storage", scope: "storage", version: 4, latest: 4 },
      { database: "storage", scope: "checkpoints", version: 2, latest: 2 },
    ]);
    expect(status.subscriberFailures).toContainEqual(
      expect.objectContaining({
        subscriber: "projection:orders",
        errorName: "Error",
        current: true,
      }),
    );
    expect(JSON.stringify(status)).not.toContain("projection is down");
    const [failure] = await store.as("ops-1").subscriberFailures.list();
    expect(failure).toMatchObject({
      subscriber: "projection:orders",
      errorMessage: "projection is down",
    });
    expect(await store.subscriberFailures.get("projection:orders")).toMatchObject({
      errorMessage: "projection is down",
    });
    expect(await store.subscriberFailures.get("projection:nothing")).toBeNull();
  });

  it("dead-letters a failing policy and lets it be discarded", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "fail-1", total: 3, customer: "ada" });
    await store.commands.payOrder({ orderId: "fail-1" });
    await runAlarm(stub);
    const [letter] = await store.deadLetters.list();
    expect(letter).toMatchObject({ kind: "policy", handler: "order.archiveOnOrderPaid" });
    expect(await rejection(store.deadLetters.retry(letter?.id ?? ""))).toMatchObject({
      message: "archive is down",
    });
    expect(await store.deadLetters.discard(letter?.id ?? "")).toMatchObject({
      status: "discarded",
    });
    expect(await store.deadLetters.list({ status: "failed" })).toEqual([]);
  });

  it("rebuilds a read model from the object's stream, leaving no alarm when nothing is pending", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "o-4", total: 5, customer: "ada" });
    await store.commands.payOrder({ orderId: "o-4" });
    await runAlarm(stub);
    // In one event of the object, an alarm the rebuild armed cannot run before it is read.
    const rebuilt = await runInDurableObject(stub, async (instance, state) => ({
      outcome: await instance.rebuildReadModel("orders"),
      alarm: await state.storage.getAlarm(),
    }));
    expect(rebuilt).toEqual({
      outcome: { ok: true, value: { events: 3, position: 3, done: true } },
      alarm: null,
    });
    expect(await store.queries.getOrder({ orderId: "o-4" })).toMatchObject({ status: "archived" });
  });

  it("refuses a call that arrives before its app is ready, and answers once it is", async () => {
    const stub = env.BARE.get(env.BARE.newUniqueId());
    const answers = await runInDurableObject(stub, async (_instance, state) => {
      const object = new QuietStore(state, env);
      const early = await object.query("getOrder", { orderId: "o-1" });
      let ready = await object.query("getOrder", { orderId: "o-1" });
      for (let round = 0; round < 100 && !ready.ok; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        ready = await object.query("getOrder", { orderId: "o-1" });
      }
      return { early, ready };
    });
    expect(answers).toEqual({
      early: {
        ok: false,
        refusal: {
          name: "ConfigurationError",
          code: "INVALID_CONFIGURATION",
          message: "The Bounda app is not ready",
        },
      },
      ready: { ok: true, value: null },
    });
  });

  it("assigns the ids of the generator it is given", async () => {
    const store = connect<typeof quietRegistry>(sliced());
    const placed = await store.commands.placeOrder({ orderId: "o-1", total: 1, customer: "ada" });
    expect(placed.eventIds).toEqual([expect.stringMatching(/^sliced-\d+$/)]);
  });

  it("arms its alarm at once after a request that leaves its policies behind", async () => {
    const before = Date.now();
    const armed = await runInDurableObject(fresh(), async (instance, state) => {
      await instance.command("placeOrder", { orderId: "o-1", total: 1, customer: "ada" });
      await instance.rebuildReadModel("orders");
      return state.storage.getAlarm();
    });
    expect(armed).toBeGreaterThanOrEqual(before);
    expect(armed).toBeLessThanOrEqual(Date.now());
  });

  it("arms its alarm at once after retrying a dead letter, and runs what the retry dispatched", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "fail-2", total: 3, customer: "ada" });
    await store.commands.payOrder({ orderId: "fail-2" });
    await runAlarm(stub);
    const [letter] = await store.deadLetters.list();
    outage.archive = false;
    const before = Date.now();
    const retried = await runInDurableObject(stub, async (instance, state) => ({
      outcome: await instance.retryDeadLetter(letter?.id ?? ""),
      alarm: await state.storage.getAlarm(),
    }));
    expect(retried.outcome).toMatchObject({ ok: true, value: { status: "retried" } });
    expect(retried.alarm).toBeGreaterThanOrEqual(before);
    expect(retried.alarm).toBeLessThanOrEqual(Date.now());
    await runAlarm(stub);
    expect(await store.queries.getOrder({ orderId: "fail-2" })).toMatchObject({
      status: "archived",
    });
  });

  it("waits at least a second before retrying a policy that failed in its alarm", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "flaky-1", total: 3, customer: "ada" });
    await store.commands.payOrder({ orderId: "flaky-1" });
    const before = Date.now();
    const armed = await runInDurableObject(stub, async (instance, state) => {
      await instance.alarm();
      return state.storage.getAlarm();
    });
    expect(armed).toBeGreaterThanOrEqual(before + 1_000);
    expect(armed).toBeLessThanOrEqual(Date.now() + 1_000);
    expect((await store.getLag()).maxLag).toBeGreaterThan(0);
  });

  it("yields after its passes per alarm and wakes itself again for the rest", async () => {
    const seen = await runInDurableObject(sliced(), async (instance, state) => {
      for (const orderId of ["o-1", "o-2"]) {
        await instance.command(
          "placeOrder",
          { orderId, total: 1, customer: "ada" },
          undefined,
          "eventual",
        );
      }
      const before = Date.now();
      await instance.alarm();
      return {
        before,
        first: await instance.query("getOrder", { orderId: "o-1" }),
        second: await instance.query("getOrder", { orderId: "o-2" }),
        alarm: await state.storage.getAlarm(),
      };
    });
    expect(seen.first).toMatchObject({ ok: true, value: { status: "placed" } });
    expect(seen.second).toEqual({ ok: true, value: null });
    expect(seen.alarm).toBeGreaterThanOrEqual(seen.before);
    expect(seen.alarm).toBeLessThanOrEqual(Date.now());
  });

  it("runs a rebuild one slice per alarm, logging each, and waking at once for the next", async () => {
    const seen = await runInDurableObject(sliced(), async (instance, state) => {
      for (const orderId of ["o-1", "o-2", "o-3"]) {
        await instance.command("placeOrder", { orderId, total: 5, customer: "ada" });
      }
      await backfilled(instance);
      logs.info.length = 0;
      const before = Date.now();
      const started = await instance.rebuildReadModel("orders");
      const alarms = [await state.storage.getAlarm()];
      for (let slice = 0; slice < 3; slice += 1) {
        await instance.alarm();
        alarms.push(await state.storage.getAlarm());
      }
      return { before, started, alarms };
    });
    expect(seen.started).toEqual({ ok: true, value: { events: 1, position: 1, done: false } });
    const last = seen.alarms.pop();
    for (const alarm of seen.alarms) {
      expect(alarm).toBeGreaterThanOrEqual(seen.before);
      expect(alarm).toBeLessThanOrEqual(Date.now());
    }
    expect(last).toBeNull();
    expect(objectLogs(logs.info)).toEqual([
      ["bounda rebuild continues", { readModel: "orders", position: 2 }],
      ["bounda rebuild continues", { readModel: "orders", position: 3 }],
      ["bounda rebuild finished", { readModel: "orders", position: 3 }],
    ]);
    expect(objectLogs(logs.error)).toEqual([]);
  });

  it("aborts a rebuild whose slice failed, keeping its live table, and holds the others a second", async () => {
    const stub = sliced();
    const store = connect<typeof quietRegistry>(stub);
    for (const orderId of ["o-1", "o-2", "o-3"]) {
      await store.commands.placeOrder({ orderId, total: 5, customer: "ada" });
    }
    const failed = await runInDurableObject(stub, async (instance, state) => {
      await backfilled(instance);
      logs.info.length = 0;
      await instance.rebuildReadModel("orders");
      await instance.rebuildReadModel("customers");
      outage.projection = true;
      const before = Date.now();
      await instance.alarm();
      return { before, alarm: await state.storage.getAlarm() };
    });
    expect(failed.alarm).toBeGreaterThanOrEqual(failed.before + 1_000);
    expect(failed.alarm).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(objectLogs(logs.error)).toEqual([
      ["bounda rebuild slice failed", { readModel: "orders", errorName: "Error" }],
    ]);
    expect(objectLogs(logs.info)).toEqual([
      ["bounda rebuild continues", { readModel: "customers", position: 2 }],
    ]);
    outage.projection = false;
    expect(await store.queries.getOrder({ orderId: "o-3" })).toMatchObject({ status: "placed" });
    expect(await store.rebuildReadModel("orders")).toEqual({ events: 1, position: 1, done: false });
  });

  it("logs every step of an alarm that cannot reach its storage, without throwing", async () => {
    await runInDurableObject(sliced(), async (instance, state) => {
      await instance.command("placeOrder", { orderId: "o-1", total: 5, customer: "ada" });
      const tables = state.storage.sql
        .exec(`SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" LIKE 'bounda_%'`)
        .toArray();
      for (const { name } of tables) state.storage.sql.exec(`DROP TABLE "${String(name)}"`);
      await instance.alarm();
    });
    expect(objectLogs(logs.error)).toEqual([
      ["bounda rebuilds could not be listed", { errorName: "Error" }],
      ["bounda alarm failed; it will be retried", { errorName: "Error" }],
      ["bounda alarm could not re-arm", { errorName: "Error" }],
    ]);
  });

  it("rebuilds in slices through its alarm, serving the live table until the last one", async () => {
    const stub = env.SLICED_STORE.get(env.SLICED_STORE.newUniqueId());
    const store = connect<typeof quietRegistry>(stub);
    for (const orderId of ["o-1", "o-2", "o-3"]) {
      await store.commands.placeOrder({ orderId, total: 5, customer: "ada" });
    }
    const progress = () =>
      runInDurableObject(stub as unknown as DurableObjectStub, (_instance, state) =>
        state.storage.sql
          .exec(`SELECT "subscriber" FROM bounda_checkpoints WHERE "subscriber" LIKE 'rebuild:%'`)
          .toArray(),
      );

    expect(await store.rebuildReadModel("orders")).toEqual({ events: 1, position: 1, done: false });
    expect(await store.queries.getOrder({ orderId: "o-3" })).toMatchObject({ status: "placed" });
    for (let round = 0; round < 50 && (await progress()).length > 0; round += 1) {
      await runAlarm(stub);
    }
    expect(await progress()).toEqual([]);
    expect(await settledAlarm(stub)).toBeNull();
    expect(await store.queries.getOrder({ orderId: "o-3" })).toMatchObject({ status: "placed" });
    expect((await store.getLag()).maxLag).toBe(0);
  });

  it("keeps each object's store to itself", async () => {
    const first = open(env.STORE.get(env.STORE.idFromName("tenant-a"))).store;
    const second = open(env.STORE.get(env.STORE.idFromName("tenant-b"))).store;
    await first.commands.placeOrder({ orderId: "o-1", total: 1, customer: "ada" });
    expect(await second.queries.getOrder({ orderId: "o-1" })).toBeNull();
    await second.commands.placeOrder({ orderId: "o-1", total: 2, customer: "grace" });
    expect(await first.queries.getOrder({ orderId: "o-1" })).toMatchObject({ total: 1 });
  });
});

describe("configForObject", () => {
  it("replaces cloudflare() definitions with the object's storage and keeps anything else", async () => {
    await runInDurableObject(fresh() as unknown as DurableObjectStub, async (_instance, state) => {
      const other = createSqliteAdapter({
        name: "elsewhere",
        options: {},
        tablePrefix: "x_",
        acquire: () => {
          throw new Error("never opened here");
        },
        release: async () => {},
      });
      const resolved = configForObject(
        {
          storage: cloudflare({ tablePrefix: "app_" }),
          readModels: { shared: cloudflare(), remote: other },
        },
        state.storage,
      );
      expect(resolved.storage).toMatchObject({
        name: "cloudflare",
        options: { tablePrefix: "app_" },
      });
      expect(resolved.storage).toHaveProperty("createStorage");
      expect(resolved.readModels?.shared).toHaveProperty("createStorage");
      expect(resolved.readModels?.remote).toBe(other);
      expect(configForObject({ storage: cloudflare() }, state.storage)).not.toHaveProperty(
        "readModels",
      );
    });
  });

  it("refuses a storage that is not cloudflare()", async () => {
    await runInDurableObject(fresh() as unknown as DurableObjectStub, async (_instance, state) => {
      expect(() =>
        configForObject(
          { storage: { kind: "bounda-adapter", name: "sqlite", options: {} } },
          state.storage,
        ),
      ).toThrow('set storage to cloudflare(), not "sqlite"');
    });
  });
});

describe("BOUNDA_ERROR_TEXT", () => {
  // An object built in the context of an empty one, so it reads the environment the test hands it.
  const failingAlarmWith = async (
    variables: Readonly<Record<string, string>>,
    runtime: { readonly telemetry?: { readonly errorText: "omit" | "include" } } = {
      telemetry: { errorText: "omit" },
    },
  ) =>
    runInDurableObject(env.BARE.get(env.BARE.newUniqueId()), async (_bare, state) => {
      const Store = createBoundaObject({
        registry: quietRegistry,
        config: { storage: cloudflare(), runtime },
        clock,
        logger: recordingLogger,
      });
      const store = new Store(state, { ...env, ...variables } as Cloudflare.Env);
      await vi.waitFor(async () => expect((await store.lag()).ok).toBe(true));
      const tables = state.storage.sql
        .exec(`SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" LIKE 'bounda_%'`)
        .toArray();
      for (const { name } of tables) state.storage.sql.exec(`DROP TABLE "${String(name)}"`);
      logs.error.length = 0;
      await store.alarm();
      return objectLogs(logs.error)[0];
    });

  it("logs the text of the object's errors when its environment includes it, over the configuration", async () => {
    expect(await failingAlarmWith({ BOUNDA_ERROR_TEXT: "include" })).toEqual([
      "bounda rebuilds could not be listed",
      {
        errorName: "Error",
        errorMessage: expect.stringContaining("no such table"),
        errorStack: expect.any(String),
      },
    ]);
    expect(await failingAlarmWith({})).toEqual([
      "bounda rebuilds could not be listed",
      { errorName: "Error" },
    ]);
    expect(
      await failingAlarmWith(
        { BOUNDA_ERROR_TEXT: "omit" },
        { telemetry: { errorText: "include" } },
      ),
    ).toEqual(["bounda rebuilds could not be listed", { errorName: "Error" }]);
    expect(await failingAlarmWith({}, { telemetry: { errorText: "include" } })).toMatchObject([
      "bounda rebuilds could not be listed",
      { errorMessage: expect.stringContaining("no such table") },
    ]);
    expect(await failingAlarmWith({ BOUNDA_ERROR_TEXT: "include" }, {})).toMatchObject([
      "bounda rebuilds could not be listed",
      { errorMessage: expect.stringContaining("no such table") },
    ]);
  });
});
