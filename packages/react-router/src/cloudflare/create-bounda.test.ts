import { cloudflare } from "@bounda-dev/adapter-cloudflare";
import {
  type AppRegistry,
  type BoundaClient,
  ConfigurationError,
  type Consistency,
} from "@bounda-dev/core";
import { type RouterContext, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { createBounda } from "./create-bounda.ts";
import { env, storeNamespace } from "./test-support.ts";

const middlewareArgs = () => {
  const context = new RouterContextProvider();
  const url = new URL("http://localhost/");
  return { context, args: { request: new Request(url), url, pattern: "/", params: {}, context } };
};

afterEach(() => {
  delete env.STORE;
});

describe("createBounda on Cloudflare", () => {
  it("puts in every request's context a client for the store its tenant names, through the Worker's binding", async () => {
    const store = storeNamespace();
    env.STORE = store.namespace;
    const { bounda, boundaMiddleware, dispose } = createBounda({
      config: { storage: cloudflare() },
      tenant: ({ request }) => new URL(request.url).hostname,
    });
    expectTypeOf(bounda).toEqualTypeOf<RouterContext<BoundaClient<AppRegistry>>>();

    const { context, args } = middlewareArgs();
    expect(await boundaMiddleware(args, async () => "next")).toBe("next");
    await Reflect.get(context.get(bounda).commands, "placeOrder")({ orderId: "o-1" });
    expect(store.calls).toEqual([
      ["localhost", "command", "placeOrder", { orderId: "o-1" }, undefined, "read-your-writes"],
    ]);
    await dispose();
  });

  it("sends commands with the consistency it is given", async () => {
    const store = storeNamespace();
    env.STORE = store.namespace;
    const { bounda, boundaMiddleware } = createBounda({
      config: { storage: cloudflare() },
      tenant: () => "acme",
      consistency: "eventual",
    });
    const { context, args } = middlewareArgs();
    await boundaMiddleware(args, async () => undefined);
    await Reflect.get(context.get(bounda).commands, "placeOrder")({ orderId: "o-1" });
    expect(store.calls).toEqual([
      ["acme", "command", "placeOrder", { orderId: "o-1" }, undefined, "eventual"],
    ]);
  });

  it("refuses at once a consistency it does not know, or a Worker it cannot serve", () => {
    env.STORE = storeNamespace().namespace;
    expect(() =>
      createBounda({
        config: { storage: cloudflare() },
        tenant: () => "acme",
        consistency: "eventually" as Consistency,
      }),
    ).toThrow(
      new ConfigurationError(
        'consistency must be "read-your-writes" or "eventual", got "eventually"',
      ),
    );
    expect(() =>
      createBounda({
        config: { storage: cloudflare({ binding: "ORDERS" }) },
        tenant: () => "acme",
      }),
    ).toThrow(ConfigurationError);
  });
});
