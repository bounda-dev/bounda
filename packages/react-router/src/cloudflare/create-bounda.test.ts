import { cloudflare } from "@bounda-dev/cloudflare";
import { witnessObjects } from "@bounda-dev/cloudflare/testing";
import {
  type AppRegistry,
  type BoundaClient,
  ConfigurationError,
  type Consistency,
  createApp,
  type HostRejection,
  idempotencyKeyFor,
  type OnHostRejectionArgs,
  type Registry,
} from "@bounda-dev/core";
import { memory } from "@bounda-dev/core/memory";
import { expectForgotten, type NotForgottenError } from "@bounda-dev/core/testing";
import { type RouterContext, RouterContextProvider } from "react-router";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createBounda } from "./create-bounda.ts";
import { env, storeNamespace } from "./test-support.ts";

// What a witness `witnessObjects` gave `host` found of an email the host logged, beside an app.
const searchedThrough = async (
  host: object,
  log: () => Promise<unknown>,
): Promise<readonly string[]> => {
  const witness = witnessObjects(class {} as never, { hosts: [host] });
  const app = await createApp({
    registry: { aggregates: {}, readModels: {} } as Registry,
    config: { storage: memory() },
    witness,
  });
  await log();
  const error = (await expectForgotten(witness, "c-1", { values: ["ana@example.com"] }).catch(
    (caught: unknown) => caught,
  )) as NotForgottenError;
  await app.stop();
  return error.found.map(({ store, field }) => `${store} ${field}`);
};

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

describe("createBounda on Cloudflare: the host log", () => {
  const requestOf = (headers: Record<string, string>) => {
    const context = new RouterContextProvider();
    const url = new URL("http://localhost/");
    return {
      context,
      args: {
        request: new Request(url, { headers }),
        url,
        pattern: "/w/:workspace",
        params: {},
        context,
      },
    };
  };

  it("records each request refused for its actor or its tenant in app/audit.ts, with the Worker's env", async () => {
    env.STORE = storeNamespace().namespace;
    const records: OnHostRejectionArgs[] = [];
    const { bounda, boundaMiddleware } = createBounda({
      config: { storage: cloudflare() },
      tenant: ({ request }) => request.headers.get("x-tenant") ?? "",
      actor: ({ request }) => {
        const user = request.headers.get("x-user");
        if (user === null) throw new Response(null, { status: 401 });
        return user;
      },
      registry: {
        audit: {
          onPersonalDataAccess: () => {},
          onHostRejection: (args) => {
            records.push(args);
          },
        },
      },
    });
    const next = async () => undefined;
    await expect(boundaMiddleware(requestOf({}).args, next)).rejects.toBeInstanceOf(Response);
    await expect(boundaMiddleware(requestOf({ "x-user": "" }).args, next)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const unnamed = requestOf({ "x-user": "user-1" });
    await boundaMiddleware(unnamed.args, next);
    await expect(unnamed.context.get(bounda).getLag()).rejects.toThrow(ConfigurationError);
    await expect(unnamed.context.get(bounda).status()).rejects.toThrow(ConfigurationError);

    const refusal = (reason: HostRejection["reason"]) => ({
      rejection: {
        at: expect.any(String),
        tenant: null,
        reason,
        target: "/w/:workspace",
        actor: null,
      },
      env,
      logger: expect.anything(),
    });
    expect(records).toEqual([
      refusal("actor-unresolved"),
      refusal("actor-invalid"),
      refusal("tenant-unresolved"),
    ]);
  });

  it("goes to the logger at info without app/audit.ts", async () => {
    env.STORE = storeNamespace().namespace;
    const entries: unknown[][] = [];
    const bounda = createBounda({
      config: { storage: cloudflare() },
      tenant: () => "acme",
      actor: () => {
        throw new Response(null, { status: 401 });
      },
      logger: {
        debug: () => undefined,
        info: (...entry: unknown[]) => void entries.push(entry),
        warn: () => undefined,
        error: () => undefined,
      },
    });
    await expect(
      bounda.boundaMiddleware(requestOf({}).args, async () => undefined),
    ).rejects.toBeInstanceOf(Response);
    expect(entries).toEqual([
      [
        "request refused",
        {
          at: expect.any(String),
          tenant: null,
          reason: "actor-unresolved",
          target: "/w/:workspace",
          actor: null,
        },
      ],
    ]);
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
    [undefined, "unset", false],
    [undefined, "include", true],
    ["include", "omit", true],
    ["omit", "include", false],
    ["loud", "include", true],
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
            : {
                runtime:
                  configured === "unset"
                    ? { role: "web" as const }
                    : { telemetry: { errorText: configured } },
              }),
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

  it("logs through the witness witnessObjects gave it", async () => {
    env.STORE = storeNamespace().namespace;
    const { lines, logger } = recording();
    const bounda = createBounda({
      config: { storage: cloudflare(), runtime: { telemetry: { errorText: "include" } } },
      tenant: () => "default",
      logger,
    });
    const found = await searchedThrough(bounda, () =>
      bounda.handleError(new Error("ana@example.com"), { request: new Request("http://w/a") }),
    );
    expect(found).toEqual(["logs fields.errorMessage", "logs fields.errorStack"]);
    expect(lines).toHaveLength(1);
  });

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
