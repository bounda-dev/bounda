import { runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const post = (path: string, body?: unknown, tenant?: string) =>
  exports.default.fetch(
    new Request(`https://bounda.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(tenant === undefined ? {} : { "x-bounda-tenant": tenant }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );

describe("createWorker", () => {
  it("dispatches a command and answers a query over JSON, for the tenant in the header", async () => {
    const placed = await post(
      "/commands/placeOrder",
      { orderId: "o-1", total: 42, customer: "ada" },
      "acme",
    );
    expect(placed.status).toBe(200);
    expect(placed.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await placed.json()).toMatchObject({ scheduled: false, aggregateId: "o-1", version: 1 });

    const found = await post("/queries/getOrder", { orderId: "o-1" }, "acme");
    expect(await found.json()).toEqual({ orderId: "o-1", status: "placed", total: 42 });
    const elsewhere = await post("/queries/getOrder", { orderId: "o-1" }, "globex");
    expect(await elsewhere.json()).toBeNull();
    const byDefault = await post("/queries/getOrder", { orderId: "o-1" });
    expect(await byDefault.json()).toBeNull();
  });

  it("schedules a command with ?delay", async () => {
    await post("/commands/placeOrder", { orderId: "o-2", total: 1, customer: "ada" }, "delays");
    const scheduled = await post("/commands/archiveOrder?delay=10m", { orderId: "o-2" }, "delays");
    expect(await scheduled.json()).toMatchObject({ scheduled: true, aggregateId: "o-2" });
    await runDurableObjectAlarm(env.STORE.get(env.STORE.idFromName("delays")));
  });

  it("answers refusals with their code and the status they mean", async () => {
    await post("/commands/placeOrder", { orderId: "o-3", total: 1, customer: "ada" }, "errors");
    const conflict = await post(
      "/commands/placeOrder",
      { orderId: "o-3", total: 1, customer: "ada" },
      "errors",
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: { code: "DOMAIN_ERROR", message: "Order already placed" },
    });

    const invalid = await post("/commands/placeOrder", { orderId: "o-4", total: "lots" }, "errors");
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as { error: { code: string; issues: unknown[] } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.issues.length).toBeGreaterThan(0);

    const unknown = await post("/commands/shipOrder", {}, "errors");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: { code: "NOT_FOUND", message: 'Unknown command "shipOrder"' },
    });

    const badJson = await post("/commands/placeOrder", "{not json", "errors");
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({
      error: { code: "INVALID_JSON", message: "The body is not JSON" },
    });
  });

  it("only knows POST on its two routes", async () => {
    const root = await exports.default.fetch(new Request("https://bounda.test/"));
    expect(root.status).toBe(404);
    expect(await root.json()).toEqual({ error: { code: "NOT_FOUND", message: "No route for /" } });
    const get = await exports.default.fetch(new Request("https://bounda.test/queries/getOrder"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });
});
