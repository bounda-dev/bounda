import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createSqliteAdapter } from "@bounda-dev/core/adapter/sqlite";
import { describe, expect, it } from "vitest";
import { configForObject } from "../src/bounda-object.ts";
import { connect } from "../src/client.ts";
import { cloudflare } from "../src/definition.ts";
import type { registry } from "./app.ts";
import { clock } from "./clock.ts";

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

  it("arms its alarm for a delayed command and runs it once the clock gets there", async () => {
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

  it("returns the domain's refusals and names what it does not know", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "o-3", total: 1, customer: "ada" });
    const refused = await rejection(
      store.commands.placeOrder({ orderId: "o-3", total: 1, customer: "ada" }),
    );
    expect(refused).toMatchObject({ name: "DomainError", message: "Order already placed" });
    expect(refused.code).toBe("DOMAIN_ERROR");
    expect(await rejection(stub.command("nope"))).toMatchObject({
      message: 'Unknown command "nope"',
      code: "NOT_FOUND",
    });
    expect(await rejection(stub.query("nope"))).toMatchObject({
      message: 'Unknown query "nope"',
      code: "NOT_FOUND",
    });
  });

  it("dead-letters a failing policy and lets it be discarded", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "fail-1", total: 3, customer: "ada" });
    await store.commands.payOrder({ orderId: "fail-1" });
    await runDurableObjectAlarm(stub);
    const [letter] = await store.deadLetters.list();
    expect(letter).toMatchObject({ kind: "policy", subscriber: "order.archiveOnOrderPaid" });
    expect(await rejection(store.deadLetters.replay(letter?.id ?? ""))).toMatchObject({
      message: "archive is down",
    });
    expect(await store.deadLetters.discard(letter?.id ?? "")).toMatchObject({
      status: "discarded",
    });
    expect(await store.deadLetters.list({ status: "failed" })).toEqual([]);
  });

  it("rebuilds a read model from the object's stream", async () => {
    const { stub, store } = open();
    await store.commands.placeOrder({ orderId: "o-4", total: 5, customer: "ada" });
    await store.commands.payOrder({ orderId: "o-4" });
    await runDurableObjectAlarm(stub);
    expect(await store.rebuildReadModel("orders")).toEqual({ events: 3, position: 3 });
    expect(await store.queries.getOrder({ orderId: "o-4" })).toMatchObject({ status: "archived" });
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
