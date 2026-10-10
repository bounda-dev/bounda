import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createSqliteAdapter } from "@bounda-dev/core/adapter/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configForObject } from "../src/bounda-object.ts";
import { connect } from "../src/client.ts";
import { cloudflare } from "../src/definition.ts";
import { outage, type processRegistry, type quietRegistry, type registry } from "./app.ts";
import { clock } from "./clock.ts";
import { logs } from "./logs.ts";
import { QuietStore } from "./test-worker.ts";

const fresh = () => env.STORE.get(env.STORE.newUniqueId());

const alarmOf = (stub: ReturnType<typeof fresh>) =>
  runInDurableObject(stub as unknown as DurableObjectStub, (_instance, state) =>
    state.storage.getAlarm(),
  );

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
    await runDurableObjectAlarm(stub);
    expect(await store.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "archived" });
    expect((await store.getLag()).maxLag).toBe(0);
    expect(await alarmOf(stub)).toBeNull();
  });

  it("arms no alarm after a command when the app has no policies or processes", async () => {
    const stub = env.QUIET_STORE.get(env.QUIET_STORE.newUniqueId());
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 42, customer: "ada" });
    expect(await store.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "placed" });
    expect((await store.getLag()).maxLag).toBe(0);
    expect(await alarmOf(stub)).toBeNull();
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

    await runDurableObjectAlarm(stub);
    const store = connect<typeof quietRegistry>(stub);
    expect(await store.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "placed" });
    expect((await store.getLag()).maxLag).toBe(0);
    expect(await alarmOf(stub)).toBeNull();
  });

  it("arms its alarm for a scheduled command and runs it once the clock gets there", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "o-2", total: 7, customer: "ada" });
    await runDurableObjectAlarm(stub);
    const before = Date.now();
    const scheduled = await store.commands.archiveOrder({ orderId: "o-2" }, { delay: "10m" });
    expect(scheduled).toMatchObject({ scheduled: true });
    const armed = await alarmOf(stub);
    expect(armed).toBeGreaterThanOrEqual(before + 600_000 - 1_000);
    expect(armed).toBeLessThanOrEqual(Date.now() + 600_000 + 1_000);

    await runDurableObjectAlarm(stub);
    expect(await store.queries.getOrder({ orderId: "o-2" })).toMatchObject({ status: "placed" });
    clock.advance(600_000);
    await runDurableObjectAlarm(stub);
    expect(await store.queries.getOrder({ orderId: "o-2" })).toMatchObject({ status: "archived" });
    expect(await alarmOf(stub)).toBeNull();
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
    // The object arms its alarm for now after a command, so the runtime may fire it on its own
    // beside the ones run here: run alarms until the object has caught up, not a fixed count.
    const caughtUp = async (steps: number) => {
      for (let round = 0; round < 10; round += 1) {
        if ((await lifecycle()).length >= steps && (await store.getLag()).maxLag === 0) return;
        await runDurableObjectAlarm(stub);
      }
    };
    const before = Date.now();
    await store.commands.placeOrder({ orderId: "o-1", total: 42, customer: "ada" });
    await caughtUp(2);
    expect(await lifecycle()).toEqual(["ProcessStarted", "ProcessHandled"]);
    const armed = await alarmOf(stub);
    expect(armed).toBeGreaterThanOrEqual(before + 3_600_000 - 1_000);
    expect(armed).toBeLessThanOrEqual(Date.now() + 3_600_000 + 1_000);

    clock.advance(3_600_000);
    await caughtUp(4);
    expect(await store.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "archived" });
    expect(await lifecycle()).toEqual([
      "ProcessStarted",
      "ProcessHandled",
      "ProcessDeadlineReached",
      "ProcessCompleted",
    ]);
    expect((await store.getLag()).maxLag).toBe(0);
    expect(await alarmOf(stub)).toBeNull();
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

  it("dead-letters a failing policy and lets it be discarded", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "fail-1", total: 3, customer: "ada" });
    await store.commands.payOrder({ orderId: "fail-1" });
    await runDurableObjectAlarm(stub);
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
    await runDurableObjectAlarm(stub);
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
    await runDurableObjectAlarm(stub);
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
    await runDurableObjectAlarm(stub);
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
      ["bounda rebuild slice failed", { readModel: "orders", message: "projection is down" }],
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
      ["bounda rebuilds could not be listed", { message: expect.any(String) }],
      ["bounda alarm failed; it will be retried", { message: expect.any(String) }],
      ["bounda alarm could not re-arm", { message: expect.any(String) }],
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
      await runDurableObjectAlarm(stub);
    }
    expect(await progress()).toEqual([]);
    expect(await alarmOf(stub)).toBeNull();
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
