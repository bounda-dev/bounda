import { env, runInDurableObject, SELF } from "cloudflare:test";
import { connect } from "@bounda-dev/cloudflare";
import { witnessObjects } from "@bounda-dev/cloudflare/testing";
import { expectForgotten } from "@bounda-dev/core/testing";
import { describe, expect, it } from "vitest";
import { Store } from "../src/worker.ts";

// Every object of the class records what its app seals, logs and traces, for expectForgotten.
witnessObjects(Store);

const post = (path: string, body: unknown, tenant: string) =>
  SELF.fetch(`http://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bounda-tenant": tenant },
    body: JSON.stringify(body),
  });

const placeOrder = (tenant: string, customerId: string, total: number) =>
  post("/commands/placeOrder", { orderId: crypto.randomUUID(), customerId, total }, tenant);

const listOrders = async (tenant: string, customerId: string) =>
  (await post("/queries/listOrders", { customerId }, tenant)).json<{
    orders: { customerId: string; total: number }[];
    total: number;
  }>();

describe("the orders API, on the Durable Object", () => {
  it("stores a command as the first version of its order", async () => {
    const response = await placeOrder("stores", "ada", 42);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scheduled: false, version: 1 });
  });

  it("answers a query with the command that came right before it", async () => {
    await placeOrder("reads", "ada", 42);
    await placeOrder("reads", "ada", 8);
    expect(await listOrders("reads", "ada")).toMatchObject({ total: 50 });
  });

  it("keeps every tenant in its own Durable Object", async () => {
    await placeOrder("tenant-a", "ada", 10);
    expect((await listOrders("tenant-a", "ada")).orders).toHaveLength(1);
    expect((await listOrders("tenant-b", "ada")).orders).toHaveLength(0);
  });

  it("refuses an invalid payload with the issues", async () => {
    const response = await post("/commands/placeOrder", { customerId: "ada", total: -1 }, "bad");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED", issues: expect.any(Array) },
    });
  });

  it("refuses to place the same order twice", async () => {
    const body = { orderId: crypto.randomUUID(), customerId: "ada", total: 1 };
    expect((await post("/commands/placeOrder", body, "twice")).status).toBe(200);
    const twice = await post("/commands/placeOrder", body, "twice");
    expect(twice.status).toBe(409);
    expect(await twice.json()).toMatchObject({ error: { rejected: "AlreadyPlaced" } });
  });

  it("names what it does not know", async () => {
    expect((await post("/commands/shipOrder", {}, "unknown")).status).toBe(404);
    expect((await post("/queries/nope", {}, "unknown")).status).toBe(404);
  });

  it("forgets a customer in their Durable Object, leaving nothing of theirs readable", async () => {
    const stub = env.STORE.get(env.STORE.idFromName("forgets"));
    const store = connect(stub);
    await store.commands.placeOrder({
      orderId: crypto.randomUUID(),
      customerId: "ada",
      total: 42,
      deliveryNote: "Leave it with the porter",
    });
    await store.forget("ada");
    expect(await listOrders("forgets", "ada")).toMatchObject({ total: 42 });
    await runInDurableObject(stub, (object) => expectForgotten(object, "ada"));
  });
});
