import { env, runInDurableObject } from "cloudflare:test";
import { connect, tenantStub } from "@bounda-dev/cloudflare";
import { witnessObjects } from "@bounda-dev/cloudflare/testing";
import { expectForgotten } from "@bounda-dev/core/testing";
import { describe, expect, it } from "vitest";
import config from "../bounda.config.ts";
import { Store } from "../workers/app.ts";

// Every object of the class records what its app seals, logs and traces, for expectForgotten.
witnessObjects(Store);

const storeOf = (tenant: string) => connect(tenantStub({ config, env, tenant }));

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
    const stub = tenantStub<Store>({ config, env, tenant: "forgets" });
    const store = connect(stub);
    await store.commands.placeOrder({
      orderId: crypto.randomUUID(),
      customerId: "ada",
      total: 42,
      deliveryNote: "Leave it with the porter",
    });
    await store.forget("ada");
    expect((await store.queries.listOrders({ customerId: "ada" })).total).toBe(42);
    await runInDurableObject(stub, (object) => expectForgotten(object, "ada"));
  });
});
