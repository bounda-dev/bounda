import { env, runInDurableObject } from "cloudflare:test";
import { connect, durableObjectAdapter } from "@bounda-dev/cloudflare";
import { expectForgotten } from "@bounda-dev/core/testing";
import { describe, expect, it } from "vitest";

const storeOf = (tenant: string) => connect(env.STORE.get(env.STORE.idFromName(tenant)));

describe("the store, in its Durable Object", () => {
  it("answers a query with the command that came right before it", async () => {
    const store = storeOf("reads");
    await store.commands.placeOrder({ orderId: crypto.randomUUID(), customerId: "ada", total: 42 });
    expect(await store.queries.listOrders({ customerId: "ada" })).toMatchObject({ total: 42 });
  });

  it("keeps every tenant in its own Durable Object", async () => {
    await storeOf("tenant-a").commands.placeOrder({
      orderId: crypto.randomUUID(),
      customerId: "ada",
      total: 10,
    });
    expect((await storeOf("tenant-b").queries.listOrders({ customerId: "ada" })).orders).toEqual(
      [],
    );
  });

  it("forgets a customer, leaving nothing of theirs readable in its SQLite", async () => {
    const stub = env.STORE.get(env.STORE.idFromName("forgets"));
    const store = connect(stub);
    await store.commands.placeOrder({
      orderId: crypto.randomUUID(),
      customerId: "ada",
      total: 42,
      deliveryNote: "Leave it with the porter",
    });
    const before = await store.exportPersonalData("ada");
    await store.forget("ada");
    expect((await store.queries.listOrders({ customerId: "ada" })).total).toBe(42);
    await runInDurableObject(stub, (_object, state) =>
      expectForgotten(durableObjectAdapter({ storage: state.storage }), "ada", { before }),
    );
  });
});
