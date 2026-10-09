import { cloudflare } from "@bounda-dev/adapter-cloudflare";
import { type BoundaClient, ConfigurationError, type Registry } from "@bounda-dev/core";
import { RouterContextProvider } from "react-router";
import { describe, expect, expectTypeOf, it } from "vitest";
import { cloudflareClients, type RequestArgs, type TenantFunction } from "./clients.ts";
import { storeNamespace } from "./test-support.ts";

const requestArgs = (params: Record<string, string> = {}): RequestArgs => {
  const url = new URL("http://localhost/");
  return {
    request: new Request(url),
    url,
    pattern: "/",
    params,
    context: new RouterContextProvider(),
  };
};

const byWorkspace: TenantFunction = ({ params }) => params.workspace ?? "default";

describe("cloudflareClients", () => {
  it("reaches the store the tenant names, through the binding the config names, only once a request uses it", async () => {
    const store = storeNamespace();
    const tenants: string[] = [];
    const clientOf = cloudflareClients<Registry>({
      env: { ORDERS: store.namespace },
      config: { storage: cloudflare({ binding: "ORDERS" }) },
      tenant: (args) => {
        const name = byWorkspace(args) as string;
        tenants.push(name);
        return name;
      },
      consistency: "eventual",
    });

    const client = clientOf(requestArgs({ workspace: "acme" }));
    expectTypeOf(client).toEqualTypeOf<BoundaClient<Registry>>();
    expect(tenants).toEqual([]);
    await Reflect.get(client.commands, "placeOrder")({ orderId: "o-1" }, { correlationId: "c-1" });
    await Reflect.get(client.queries, "getOrder")({ orderId: "o-1" });
    expect(tenants).toEqual(["acme"]);
    expect(store.calls).toEqual([
      ["acme", "command", "placeOrder", { orderId: "o-1" }, { correlationId: "c-1" }, "eventual"],
      ["acme", "query", "getOrder", { orderId: "o-1" }],
    ]);

    await Reflect.get(clientOf(requestArgs()).queries, "getOrder")({ orderId: "o-1" });
    expect(tenants).toEqual(["acme", "default"]);
  });

  it("sends every operation of the client to the store", async () => {
    const store = storeNamespace();
    const client = cloudflareClients<Registry>({
      env: { STORE: store.namespace },
      config: { storage: cloudflare() },
      tenant: async () => "acme",
      consistency: "read-your-writes",
    })(requestArgs());

    await client.getLag();
    await client.deadLetters.list({ limit: 5 });
    await client.deadLetters.retry("d-1");
    await client.deadLetters.discard("d-2");
    await client.rebuildReadModel("orders");
    expect(store.calls).toEqual([
      ["acme", "lag"],
      ["acme", "listDeadLetters", { limit: 5 }],
      ["acme", "retryDeadLetter", "d-1"],
      ["acme", "discardDeadLetter", "d-2"],
      ["acme", "rebuildReadModel", "orders"],
    ]);
  });

  it("names the tenant once per request even when it throws", async () => {
    const store = storeNamespace();
    let calls = 0;
    const client = cloudflareClients<Registry>({
      env: { STORE: store.namespace },
      config: { storage: cloudflare() },
      tenant: () => {
        calls += 1;
        throw new Error("no session");
      },
      consistency: "read-your-writes",
    })(requestArgs());

    await expect(client.getLag()).rejects.toThrow("no session");
    await expect(client.getLag()).rejects.toThrow("no session");
    expect(calls).toBe(1);
    expect(store.calls).toEqual([]);
  });

  it("rejects every call of a request whose tenant is not a string", async () => {
    const store = storeNamespace();
    const client = cloudflareClients<Registry>({
      env: { STORE: store.namespace },
      config: { storage: cloudflare() },
      tenant: (() => undefined) as unknown as TenantFunction,
      consistency: "read-your-writes",
    })(requestArgs());

    const refusal = new ConfigurationError(
      "tenant must name the store of a request with a string, got undefined",
    );
    await expect(client.getLag()).rejects.toThrow(refusal);
    await expect(client.deadLetters.list()).rejects.toThrow(refusal);
    expect(store.calls).toEqual([]);
  });

  it("refuses a storage that is not cloudflare()", () => {
    expect(() =>
      cloudflareClients({
        env: {},
        config: { storage: { kind: "bounda-adapter", name: "sqlite", options: {} } },
        tenant: byWorkspace,
        consistency: "read-your-writes",
      }),
    ).toThrow(
      new ConfigurationError(
        "React Router on Cloudflare serves an app that runs in a Durable Object: set storage to cloudflare() in bounda.config.ts",
      ),
    );
  });

  it("refuses a Worker without the binding", () => {
    expect(() =>
      cloudflareClients({
        env: { STORE: storeNamespace().namespace },
        config: { storage: cloudflare({ binding: "ORDERS" }) },
        tenant: byWorkspace,
        consistency: "read-your-writes",
      }),
    ).toThrow(
      new ConfigurationError(
        'The Worker has no binding "ORDERS": bind the Bounda Durable Object under that name in wrangler.jsonc, or name its binding with cloudflare({ binding })',
      ),
    );
  });

  it("refuses a tenant that is not a function", () => {
    expect(() =>
      cloudflareClients({
        env: { STORE: storeNamespace().namespace },
        config: { storage: cloudflare() },
        tenant: "acme" as unknown as TenantFunction,
        consistency: "read-your-writes",
      }),
    ).toThrow(
      new ConfigurationError(
        'tenant must be a function that names the store of a request, such as () => "default"',
      ),
    );
  });
});
