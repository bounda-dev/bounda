import { env } from "cloudflare:test";
import { connect } from "@bounda-dev/cloudflare";
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
});
