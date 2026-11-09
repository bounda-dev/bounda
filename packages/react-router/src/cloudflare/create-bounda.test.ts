import { cloudflare } from "@bounda-dev/cloudflare";
import {
  type AppRegistry,
  type BoundaClient,
  ConfigurationError,
  type Consistency,
  idempotencyKeyFor,
} from "@bounda-dev/core";
import { type RouterContext, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
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
      [
        "localhost",
        "command",
        "placeOrder",
        { orderId: "o-1" },
        undefined,
        "read-your-writes",
        undefined,
      ],
    ]);
    await dispose();
  });

  it("sends who makes the request, as actor names them, with its commands", async () => {
    const store = storeNamespace();
    env.STORE = store.namespace;
    const { bounda, boundaMiddleware } = createBounda({
      config: { storage: cloudflare() },
      tenant: () => "acme",
      actor: async () => "user-1",
    });
    const { context, args } = middlewareArgs();
    await boundaMiddleware(args, async () => undefined);
    await Reflect.get(context.get(bounda).commands, "placeOrder")({ orderId: "o-1" });
    expect(store.calls).toEqual([
      [
        "acme",
        "command",
        "placeOrder",
        { orderId: "o-1" },
        undefined,
        "read-your-writes",
        "user-1",
      ],
    ]);
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
      ["acme", "command", "placeOrder", { orderId: "o-1" }, undefined, "eventual", undefined],
    ]);
  });

  it("keys every command of the request from its Idempotency-Key header", async () => {
    const store = storeNamespace();
    env.STORE = store.namespace;
    const { bounda, boundaMiddleware } = createBounda({
      config: { storage: cloudflare() },
      tenant: () => "acme",
      consistency: "eventual",
    });
    const { context, args } = middlewareArgs();
    args.request.headers.set("Idempotency-Key", "req-1");
    await boundaMiddleware(args, async () => undefined);
    const commands = context.get(bounda).commands;
    await Reflect.get(commands, "placeOrder")({ orderId: "o-1" }, { correlationId: "c-1" });
    await Reflect.get(commands, "payOrder")({ orderId: "o-1" }, { idempotencyKey: "own" });
    expect(store.calls).toEqual([
      [
        "acme",
        "command",
        "placeOrder",
        { orderId: "o-1" },
        { idempotencyKey: idempotencyKeyFor("req-1", "placeOrder"), correlationId: "c-1" },
        "eventual",
        undefined,
      ],
      [
        "acme",
        "command",
        "payOrder",
        { orderId: "o-1" },
        { idempotencyKey: "own" },
        "eventual",
        undefined,
      ],
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

describe("createBounda on Cloudflare: handleError", () => {
  const recording = () => {
    const lines: unknown[][] = [];
    return {
      lines,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (...entry: unknown[]) => void lines.push(entry),
      },
    };
  };

  afterEach(() => {
    delete env.BOUNDA_ERROR_TEXT;
  });

  it.each([
    [undefined, undefined, false],
    [undefined, "include", true],
    ["include", "omit", true],
    ["omit", "include", false],
    ["loud", "include", false],
  ] as const)(
    "logs the text as BOUNDA_ERROR_TEXT %s says, over the configuration's %s",
    async (variable, configured, included) => {
      env.STORE = storeNamespace().namespace;
      if (variable !== undefined) env.BOUNDA_ERROR_TEXT = variable;
      const { lines, logger } = recording();
      const { handleError } = createBounda({
        config: {
          storage: cloudflare(),
          ...(configured === undefined
            ? {}
            : { runtime: { telemetry: { errorText: configured } } }),
        },
        tenant: () => "default",
        logger,
      });
      await handleError(new Error("ana@example.com"), { request: new Request("http://w/a") });
      expect(lines).toEqual([
        [
          "bounda request failed",
          included
            ? {
                method: "GET",
                path: "/a",
                errorName: "Error",
                errorMessage: "ana@example.com",
                errorStack: expect.any(String),
              }
            : { method: "GET", errorName: "Error" },
        ],
      ]);
    },
  );

  it("logs one JSON line per entry by default, as Workers Logs reads them", async () => {
    env.STORE = storeNamespace().namespace;
    const written: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => void written.push(args));
    try {
      const { handleError } = createBounda({
        config: { storage: cloudflare() },
        tenant: () => "default",
      });
      await handleError(new Error("ana@example.com"), { request: new Request("http://w/a") });
    } finally {
      spy.mockRestore();
    }
    expect(written).toEqual([
      ['{"level":"error","message":"bounda request failed","method":"GET","errorName":"Error"}'],
    ]);
  });
});
