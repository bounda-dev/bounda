import { cloudflare } from "@bounda-dev/cloudflare";
import { ConfigurationError, type Consistency, type Registry } from "@bounda-dev/core";
import type { ImportModuleFunction } from "@bounda-dev/core/node";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, type FakeStoreNamespace, storeNamespace } from "../cloudflare/test-support.ts";
import { failure } from "../failure.ts";
import * as cloudflareHost from "./cloudflare.ts";
import { createHost } from "./cloudflare.ts";

const registry = { aggregates: {}, readModels: {} } as Registry;

const middlewareArgs = () => {
  const context = new RouterContextProvider();
  const url = new URL("http://localhost/");
  return { context, args: { request: new Request(url), url, pattern: "/", params: {}, context } };
};

const counted = (module: Readonly<Record<string, unknown>>) => {
  const imported = { count: 0 };
  const load: ImportModuleFunction = async () => {
    imported.count += 1;
    return module;
  };
  return { load, imported };
};

let store: FakeStoreNamespace;

beforeEach(() => {
  store = storeNamespace();
  env.STORE = store.namespace;
});

afterEach(() => {
  delete env.STORE;
});

describe("createHost under the workerd condition", () => {
  it("imports the configuration and the tenant on the first request only, and serves the tenant's store", async () => {
    const config = counted({ default: { storage: cloudflare() } });
    const tenant = counted({ tenant: () => "acme" });
    const { bounda, boundaMiddleware } = createHost({
      root: "/project",
      registry,
      importConfig: config.load,
      importTenant: tenant.load,
      consistency: "eventual",
    });
    expect([config.imported.count, tenant.imported.count]).toEqual([0, 0]);

    for (const orderId of ["o-1", "o-2"]) {
      const { context, args } = middlewareArgs();
      await boundaMiddleware(args, async () => undefined);
      await Reflect.get(context.get(bounda).commands, "placeOrder")({ orderId });
    }
    expect([config.imported.count, tenant.imported.count]).toEqual([1, 1]);
    expect(store.calls).toEqual([
      ["acme", "command", "placeOrder", { orderId: "o-1" }, undefined, "eventual"],
      ["acme", "command", "placeOrder", { orderId: "o-2" }, undefined, "eventual"],
    ]);
  });

  it("rejects a request when the project has no app/tenant.ts", async () => {
    const { boundaMiddleware } = createHost({
      registry,
      importConfig: async () => ({ default: { storage: cloudflare() } }),
      consistency: "read-your-writes",
    });
    await expect(boundaMiddleware(middlewareArgs().args, async () => undefined)).rejects.toThrow(
      new ConfigurationError(
        'On Cloudflare every request reaches the store of its tenant: create app/tenant.ts and export tenant from it, a function of the request that names the store, such as () => "default" for a single one',
      ),
    );
  });

  it("rejects a request while app/tenant.ts exports no tenant, and imports it again on the next", async () => {
    const modules: Readonly<Record<string, unknown>>[] = [{}, { tenant: () => "acme" }];
    const { bounda, boundaMiddleware } = createHost({
      registry,
      importConfig: async () => ({ default: { storage: cloudflare() } }),
      importTenant: async () => modules.shift() ?? {},
      consistency: "read-your-writes",
    });
    await expect(boundaMiddleware(middlewareArgs().args, async () => undefined)).rejects.toThrow(
      new ConfigurationError(
        "app/tenant.ts does not export tenant, a function of the request that names its store",
      ),
    );
    const { context, args } = middlewareArgs();
    await boundaMiddleware(args, async () => undefined);
    await context.get(bounda).getLag();
    expect(store.calls).toEqual([["acme", "lag"]]);
  });

  it("rejects a request when bounda.config.ts has no default export", async () => {
    const { boundaMiddleware } = createHost({
      registry,
      importConfig: async () => ({}),
      importTenant: async () => ({ tenant: () => "acme" }),
      consistency: "read-your-writes",
    });
    await expect(boundaMiddleware(middlewareArgs().args, async () => undefined)).rejects.toThrow(
      new ConfigurationError("bounda.config.ts does not export the configuration (default export)"),
    );
  });

  it("refuses at once a consistency it does not know", () => {
    expect(() =>
      createHost({
        registry,
        importConfig: async () => ({}),
        consistency: "eventually" as Consistency,
      }),
    ).toThrow(
      new ConfigurationError(
        'consistency must be "read-your-writes" or "eventual", got "eventually"',
      ),
    );
  });

  it("hands the plugin's module failure too, so that the Worker loads nothing else", () => {
    expect(cloudflareHost.failure).toBe(failure);
  });

  it("does nothing on dispose", async () => {
    const config = counted({ default: { storage: cloudflare() } });
    const { dispose } = createHost({
      registry,
      importConfig: config.load,
      consistency: "eventual",
    });
    await expect(dispose()).resolves.toBeUndefined();
    expect(config.imported.count).toBe(0);
  });
});
