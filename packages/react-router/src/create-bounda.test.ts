import {
  type BoundaApp,
  ConfigurationError,
  createApp,
  type DispatchOptions,
  type HostRejection,
  idempotencyKeyFor,
  type OnHostRejectionArgs,
  type Registry,
  silentLogger,
  ValidationError,
  type Witness,
} from "@bounda-dev/core";
import { memory } from "@bounda-dev/core/memory";
import { createWitness, expectForgotten, type NotForgottenError } from "@bounda-dev/core/testing";
import { RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { createBounda, DEFAULT_TENANT_APPS, DEFAULT_TENANT_IDLE_MS } from "./create-bounda.ts";

interface FakeApp {
  readonly app: BoundaApp;
  readonly calls: string[];
}

const drained = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const fakeApp = (name: string): FakeApp => {
  const calls: string[] = [];
  const app = {
    name,
    commands: {
      placeOrder: async () => {
        calls.push("placeOrder");
        return { scheduled: false, aggregateId: "o-1", version: 1, eventIds: [] };
      },
    },
    catchUpReadModels: async () => {
      calls.push("catchUp");
    },
    start: () => {
      calls.push("start");
    },
    stop: async () => {
      calls.push("stop");
    },
    config: { runtime: { telemetry: { errorText: "omit" } } },
  } as unknown as BoundaApp;
  return { app, calls };
};

interface OrderCommands {
  readonly placeOrder: () => Promise<unknown>;
}

let keys = 0;
const uniqueKey = (): string => `bounda.test.${process.pid}.${++keys}`;

const url = new URL("http://localhost/");

const middlewareArgs = () => {
  const context = new RouterContextProvider();
  return { context, args: { request: new Request(url), url, pattern: "/", params: {}, context } };
};

// An app whose commands record who they act as and the idempotency key they carry.
const actingApp = (): { readonly app: BoundaApp; readonly calls: unknown[][] } => {
  const calls: unknown[][] = [];
  const clientAs = (actor?: string) => ({
    commands: {
      placeOrder: async (_payload?: unknown, options?: DispatchOptions) => {
        calls.push([actor, options?.idempotencyKey]);
        return { scheduled: false, aggregateId: "o-1", version: 1, eventIds: [] };
      },
    },
    as: (next: string) => clientAs(next),
  });
  const app = {
    ...clientAs(),
    catchUpReadModels: async () => {
      calls.push(["catchUp"]);
    },
    start: () => undefined,
    stop: async () => undefined,
    config: { runtime: { telemetry: { errorText: "omit" } } },
  } as unknown as BoundaApp;
  return { app, calls };
};

describe("createBounda", () => {
  it("acts as who makes each request, keeping the request's key and its own writes when bound again", async () => {
    const acting = actingApp();
    const { bounda, boundaMiddleware, dispose } = createBounda({
      key: uniqueKey(),
      boot: async () => acting.app,
      actor: ({ request }) => request.headers.get("x-user") ?? undefined,
    });
    const signedIn = middlewareArgs();
    signedIn.args.request.headers.set("x-user", "user-1");
    signedIn.args.request.headers.set("Idempotency-Key", "req-1");
    await boundaMiddleware(signedIn.args, async () => undefined);
    const served = signedIn.context.get(bounda);
    await (served.commands as unknown as OrderCommands).placeOrder();
    await (served.as("user-2").commands as unknown as OrderCommands).placeOrder();
    const anonymous = middlewareArgs();
    await boundaMiddleware(anonymous.args, async () => undefined);
    await (anonymous.context.get(bounda).commands as unknown as OrderCommands).placeOrder();

    const key = idempotencyKeyFor("req-1", "placeOrder");
    expect(acting.calls).toEqual([
      ["user-1", key],
      ["catchUp"],
      ["user-2", key],
      ["catchUp"],
      [undefined, undefined],
      ["catchUp"],
    ]);
    await dispose();
  });

  it("serves an app that reads its own writes by default", async () => {
    const fake = fakeApp("one");
    const { bounda, boundaMiddleware } = createBounda({
      key: uniqueKey(),
      boot: async () => fake.app,
    });
    const { context, args } = middlewareArgs();
    await boundaMiddleware(args, async () => undefined);

    const served = context.get(bounda);
    expect(served).not.toBe(fake.app);
    await (served.commands as unknown as OrderCommands).placeOrder();
    expect(fake.calls).toEqual(["start", "placeOrder", "catchUp"]);
    await (served as BoundaApp).stop();
    expect(fake.calls).toEqual(["start", "placeOrder", "catchUp", "stop"]);
  });

  it("serves the app as booted with eventual consistency", async () => {
    const fake = fakeApp("one");
    const { bounda, boundaMiddleware } = createBounda({
      key: uniqueKey(),
      consistency: "eventual",
      boot: async () => fake.app,
    });
    const { context, args } = middlewareArgs();
    await boundaMiddleware(args, async () => undefined);

    expect(context.get(bounda)).toBe(fake.app);
    await (context.get(bounda).commands as unknown as OrderCommands).placeOrder();
    expect(fake.calls).toEqual(["start", "placeOrder"]);
  });

  it('refuses a consistency it does not know, such as the old "immediate"', () => {
    const create = () =>
      createBounda({
        key: uniqueKey(),
        consistency: "immediate" as never,
        boot: async () => fakeApp("one").app,
      });
    expect(create).toThrow(
      new ConfigurationError(
        'consistency must be "read-your-writes" or "eventual", got "immediate"',
      ),
    );
  });

  it("boots once, starts the app and provides it to every request", async () => {
    const fake = fakeApp("one");
    let boots = 0;
    const { bounda, boundaMiddleware } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: async () => {
        boots += 1;
        return fake.app;
      },
    });

    const first = middlewareArgs();
    const second = middlewareArgs();
    const results = await Promise.all([
      boundaMiddleware(first.args, async () => "first"),
      boundaMiddleware(second.args, async () => "second"),
    ]);
    await boundaMiddleware(middlewareArgs().args, async () => undefined);

    expect(results).toEqual(["first", "second"]);
    expect(boots).toBe(1);
    expect(fake.calls).toEqual(["start"]);
    expect(first.context.get(bounda)).toBe(fake.app);
    expect(second.context.get(bounda)).toBe(fake.app);
  });

  it("keys the commands it serves from the request's Idempotency-Key header", async () => {
    const options: unknown[] = [];
    const app = {
      commands: {
        placeOrder: async (_payload: unknown, dispatch?: unknown) => {
          options.push(dispatch);
          return { scheduled: false };
        },
      },
      start: () => undefined,
      stop: async () => undefined,
      config: { runtime: { telemetry: { errorText: "omit" } } },
    } as unknown as BoundaApp;
    const { bounda, boundaMiddleware } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: async () => app,
    });
    const keyed = middlewareArgs();
    keyed.args.request.headers.set("Idempotency-Key", "req-1");
    await boundaMiddleware(keyed.args, async () => undefined);
    const plain = middlewareArgs();
    await boundaMiddleware(plain.args, async () => undefined);
    const commandsOf = (context: RouterContextProvider) =>
      context.get(bounda).commands as unknown as {
        placeOrder: (payload: unknown, options?: unknown) => Promise<unknown>;
      };
    await commandsOf(keyed.context).placeOrder({ orderId: "o-1" });
    await commandsOf(keyed.context).placeOrder({ orderId: "o-1" }, { idempotencyKey: "own" });
    await commandsOf(plain.context).placeOrder({ orderId: "o-1" });
    expect(options).toEqual([
      { idempotencyKey: idempotencyKeyFor("req-1", "placeOrder") },
      { idempotencyKey: "own" },
      undefined,
    ]);
    expect(plain.context.get(bounda)).toBe(app);
  });

  it("keys the commands from the idempotencyKey field of a posted form, leaving the body to the action", async () => {
    const options: unknown[] = [];
    const app = {
      commands: {
        placeOrder: async (_payload: unknown, dispatch?: unknown) => {
          options.push(dispatch);
          return { scheduled: false };
        },
      },
      start: () => undefined,
      stop: async () => undefined,
      config: { runtime: { telemetry: { errorText: "omit" } } },
    } as unknown as BoundaApp;
    const { bounda, boundaMiddleware } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: async () => app,
    });
    const { context, args } = middlewareArgs();
    const request = new Request(url, {
      method: "POST",
      body: new URLSearchParams({ idempotencyKey: "form-1", orderId: "o-1" }),
    });
    await boundaMiddleware({ ...args, request }, async () => undefined);
    const orderId = (await request.formData()).get("orderId");
    await (
      context.get(bounda).commands as unknown as {
        placeOrder: (payload: unknown) => Promise<unknown>;
      }
    ).placeOrder({ orderId });
    expect(options).toEqual([{ idempotencyKey: idempotencyKeyFor("form-1", "placeOrder") }]);
  });

  it("returns what next returns, awaiting it", async () => {
    const { boundaMiddleware } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: async () => fakeApp("one").app,
    });
    const response = new Response("ok");
    await expect(boundaMiddleware(middlewareArgs().args, async () => response)).resolves.toBe(
      response,
    );
  });

  it("does not put the app in the context until it has booted", async () => {
    const fake = fakeApp("one");
    let release: () => void = () => undefined;
    const { bounda, boundaMiddleware } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: () =>
        new Promise<BoundaApp>((resolve) => {
          release = () => resolve(fake.app);
        }),
    });
    const { context, args } = middlewareArgs();
    const pending = boundaMiddleware(args, async () => "done");
    await Promise.resolve();
    expect(() => context.get(bounda)).toThrow("No value found for context");
    release();
    expect(await pending).toBe("done");
    expect(context.get(bounda)).toBe(fake.app);
  });

  it("retries the boot on the next request after a failure", async () => {
    const fake = fakeApp("one");
    let attempts = 0;
    const { bounda, boundaMiddleware } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("database is down");
        return fake.app;
      },
    });

    await expect(boundaMiddleware(middlewareArgs().args, async () => "unreached")).rejects.toThrow(
      "database is down",
    );
    const { context, args } = middlewareArgs();
    expect(await boundaMiddleware(args, async () => "served")).toBe("served");
    expect(attempts).toBe(2);
    expect(context.get(bounda)).toBe(fake.app);
    expect(fake.calls).toEqual(["start"]);
  });

  it("stops the app of a previous declaration with the same key and boots afresh", async () => {
    const key = uniqueKey();
    const first = fakeApp("first");
    const second = fakeApp("second");
    const before = createBounda({ consistency: "eventual", key, boot: async () => first.app });
    await before.boundaMiddleware(middlewareArgs().args, async () => undefined);

    const after = createBounda({ consistency: "eventual", key, boot: async () => second.app });
    const { context, args } = middlewareArgs();
    await after.boundaMiddleware(args, async () => undefined);
    expect(first.calls).toEqual(["start", "stop"]);
    expect(context.get(after.bounda)).toBe(second.app);
    expect(second.calls).toEqual(["start"]);
  });

  it("boots the next app only once the previous one has stopped", async () => {
    const key = uniqueKey();
    const timeline: string[] = [];
    const first = fakeApp("first");
    const stopped = Promise.withResolvers<void>();
    first.app.stop = async () => {
      await stopped.promise;
      timeline.push("first stopped");
    };
    const before = createBounda({ consistency: "eventual", key, boot: async () => first.app });
    await before.boundaMiddleware(middlewareArgs().args, async () => undefined);

    const after = createBounda({
      consistency: "eventual",
      key,
      boot: async () => {
        timeline.push("second booted");
        return fakeApp("second").app;
      },
    });
    const serving = after.boundaMiddleware(middlewareArgs().args, async () => undefined);
    await drained();
    expect(timeline).toEqual([]);
    stopped.resolve();
    await serving;
    expect(timeline).toEqual(["first stopped", "second booted"]);
  });

  it("waits for every app retired before it, through declarations that booted nothing", async () => {
    const key = uniqueKey();
    const timeline: string[] = [];
    const first = fakeApp("first");
    const stopped = Promise.withResolvers<void>();
    first.app.stop = async () => {
      await stopped.promise;
      timeline.push("first stopped");
    };
    const one = createBounda({ consistency: "eventual", key, boot: async () => first.app });
    await one.boundaMiddleware(middlewareArgs().args, async () => undefined);

    createBounda({ consistency: "eventual", key, boot: async () => fakeApp("unused").app });
    const three = createBounda({
      consistency: "eventual",
      key,
      boot: async () => {
        timeline.push("third booted");
        return fakeApp("third").app;
      },
    });
    const serving = three.boundaMiddleware(middlewareArgs().args, async () => undefined);
    await drained();
    expect(timeline).toEqual([]);
    stopped.resolve();
    await serving;
    expect(timeline).toEqual(["first stopped", "third booted"]);
  });

  it("stops a boot still in flight when it is declared again", async () => {
    const key = uniqueKey();
    const first = fakeApp("first");
    let release: () => void = () => undefined;
    const before = createBounda({
      consistency: "eventual",
      key,
      boot: () =>
        new Promise<BoundaApp>((resolve) => {
          release = () => resolve(first.app);
        }),
    });
    const pending = before.boundaMiddleware(middlewareArgs().args, async () => undefined);

    const again = createBounda({
      consistency: "eventual",
      key,
      boot: async () => fakeApp("second").app,
    });
    release();
    await pending;
    await again.boundaMiddleware(middlewareArgs().args, async () => undefined);
    expect(first.calls).toEqual(["start", "stop"]);
  });

  it("resolves dispose only once every app retired under its key has stopped", async () => {
    const key = uniqueKey();
    const timeline: string[] = [];
    const first = fakeApp("first");
    const stopped = Promise.withResolvers<void>();
    first.app.stop = async () => {
      await stopped.promise;
      timeline.push("first stopped");
    };
    const one = createBounda({ consistency: "eventual", key, boot: async () => first.app });
    await one.boundaMiddleware(middlewareArgs().args, async () => undefined);

    const two = createBounda({
      consistency: "eventual",
      key,
      boot: async () => fakeApp("two").app,
    });
    const disposing = two.dispose().then(() => timeline.push("disposed"));
    await drained();
    expect(timeline).toEqual([]);
    stopped.resolve();
    await disposing;
    expect(timeline).toEqual(["first stopped", "disposed"]);
  });

  it("boots at once again once a reload has finished stopping the previous app", async () => {
    const key = uniqueKey();
    const one = createBounda({
      consistency: "eventual",
      key,
      boot: async () => fakeApp("one").app,
    });
    await one.boundaMiddleware(middlewareArgs().args, async () => undefined);

    let booting = false;
    const two = createBounda({
      consistency: "eventual",
      key,
      boot: async () => {
        booting = true;
        return fakeApp("two").app;
      },
    });
    await drained();
    const serving = two.boundaMiddleware(middlewareArgs().args, async () => undefined);
    expect(booting).toBe(true);
    await serving;
  });

  it("keeps waiting for a later retirement when an earlier one finishes first", async () => {
    const key = uniqueKey();
    const timeline: string[] = [];
    const gated = (name: string) => {
      const app = fakeApp(name);
      const release = Promise.withResolvers<void>();
      app.app.stop = async () => {
        await release.promise;
        timeline.push(`${name} stopped`);
      };
      return { app: app.app, release: release.resolve };
    };
    const first = gated("first");
    const second = gated("second");
    const one = createBounda({ consistency: "eventual", key, boot: async () => first.app });
    await one.boundaMiddleware(middlewareArgs().args, async () => undefined);

    const two = createBounda({ consistency: "eventual", key, boot: async () => second.app });
    const booted = two.boundaMiddleware(middlewareArgs().args, async () => undefined);
    const three = createBounda({
      consistency: "eventual",
      key,
      boot: async () => {
        timeline.push("third booted");
        return fakeApp("third").app;
      },
    });
    first.release();
    await booted.catch(() => undefined);
    const serving = three.boundaMiddleware(middlewareArgs().args, async () => undefined);
    await drained();
    expect(timeline).toEqual(["first stopped"]);
    second.release();
    await serving;
    expect(timeline).toEqual(["first stopped", "second stopped", "third booted"]);
  });

  it("keeps apps under different keys apart", async () => {
    const one = fakeApp("one");
    const two = fakeApp("two");
    const first = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: async () => one.app,
    });
    const second = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: async () => two.app,
    });

    const a = middlewareArgs();
    const b = middlewareArgs();
    await first.boundaMiddleware(a.args, async () => undefined);
    await second.boundaMiddleware(b.args, async () => undefined);

    expect(a.context.get(first.bounda)).toBe(one.app);
    expect(b.context.get(second.bounda)).toBe(two.app);
  });

  it("stops the app on dispose and boots a fresh one afterwards", async () => {
    const first = fakeApp("first");
    const second = fakeApp("second");
    const apps = [first, second];
    const { bounda, boundaMiddleware, dispose } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: async () => {
        const next = apps.shift();
        if (next === undefined) throw new Error("no more apps");
        return next.app;
      },
    });

    await boundaMiddleware(middlewareArgs().args, async () => undefined);
    await dispose();
    expect(first.calls).toEqual(["start", "stop"]);

    const { context, args } = middlewareArgs();
    await boundaMiddleware(args, async () => undefined);
    expect(context.get(bounda)).toBe(second.app);
    expect(second.calls).toEqual(["start"]);
  });

  it("waits for a boot in flight before stopping it on dispose", async () => {
    const fake = fakeApp("one");
    let release: () => void = () => undefined;
    const { boundaMiddleware, dispose } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: () =>
        new Promise<BoundaApp>((resolve) => {
          release = () => resolve(fake.app);
        }),
    });
    const pending = boundaMiddleware(middlewareArgs().args, async () => undefined);
    const disposing = dispose();
    release();
    await pending;
    await disposing;
    expect(fake.calls).toEqual(["start", "stop"]);
  });

  it("keeps the app booting in its place when a disposed boot fails late", async () => {
    const replacement = fakeApp("replacement");
    let failFirst: (error: Error) => void = () => undefined;
    let boots = 0;
    const { bounda, boundaMiddleware, dispose } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: () => {
        boots += 1;
        return boots === 1
          ? new Promise<BoundaApp>((_, reject) => {
              failFirst = reject;
            })
          : Promise.resolve(replacement.app);
      },
    });

    const first = boundaMiddleware(middlewareArgs().args, async () => undefined);
    const disposing = dispose();
    const { context, args } = middlewareArgs();
    const second = boundaMiddleware(args, async () => "served");
    failFirst(new Error("late failure"));
    await expect(first).rejects.toThrow("late failure");
    await disposing;
    expect(await second).toBe("served");
    expect(context.get(bounda)).toBe(replacement.app);

    await boundaMiddleware(middlewareArgs().args, async () => undefined);
    expect(boots).toBe(2);
  });

  it("disposes quietly when nothing booted or the boot failed", async () => {
    const idle = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: async () => fakeApp("idle").app,
    });
    await expect(idle.dispose()).resolves.toBeUndefined();

    let release: (error: Error) => void = () => undefined;
    const failing = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      boot: () =>
        new Promise<BoundaApp>((_, reject) => {
          release = reject;
        }),
    });
    const pending = failing.boundaMiddleware(middlewareArgs().args, async () => undefined);
    const disposing = failing.dispose();
    release(new Error("boom"));
    await expect(pending).rejects.toThrow("boom");
    await expect(disposing).resolves.toBeUndefined();
  });
});

describe("createBounda with a tenant per request", () => {
  const requestFor = (tenant: string) => {
    const context = new RouterContextProvider();
    const request = new Request(url, { headers: { "x-tenant": tenant } });
    return { context, args: { request, url, pattern: "/", params: {}, context } };
  };
  const tenantOfHeader = ({ request }: { readonly request: Request }) =>
    request.headers.get("x-tenant") ?? "default";

  it("boots one app for each tenant, with its name, and serves each request its tenant's", async () => {
    const booted: (string | undefined)[] = [];
    const apps = new Map<string, FakeApp>();
    const { bounda, boundaMiddleware } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      tenant: tenantOfHeader,
      boot: async (args) => {
        booted.push(args?.tenant);
        const app = fakeApp(args?.tenant ?? "none");
        apps.set(args?.tenant ?? "none", app);
        return app.app;
      },
    });
    const acme = requestFor("acme");
    const globex = requestFor("globex");
    const again = requestFor("acme");
    await Promise.all([
      boundaMiddleware(acme.args, async () => undefined),
      boundaMiddleware(globex.args, async () => undefined),
    ]);
    await boundaMiddleware(again.args, async () => undefined);
    expect(booted.sort()).toEqual(["acme", "globex"]);
    expect(acme.context.get(bounda)).toBe(apps.get("acme")?.app);
    expect(again.context.get(bounda)).toBe(apps.get("acme")?.app);
    expect(globex.context.get(bounda)).toBe(apps.get("globex")?.app);
  });

  it("stops every tenant's app on dispose, and on a declaration again under the same key", async () => {
    const key = uniqueKey();
    const apps: FakeApp[] = [];
    const declare = () =>
      createBounda({
        consistency: "eventual",
        key,
        tenant: tenantOfHeader,
        boot: async (args) => {
          const app = fakeApp(args?.tenant ?? "none");
          apps.push(app);
          return app.app;
        },
      });
    const first = declare();
    await first.boundaMiddleware(requestFor("acme").args, async () => undefined);
    await first.boundaMiddleware(requestFor("globex").args, async () => undefined);
    await first.dispose();
    expect(apps.map(({ calls }) => calls)).toEqual([
      ["start", "stop"],
      ["start", "stop"],
    ]);
    await first.boundaMiddleware(requestFor("acme").args, async () => undefined);
    const second = declare();
    await second.boundaMiddleware(requestFor("acme").args, async () => undefined);
    expect(apps.map(({ calls }) => calls)).toEqual([
      ["start", "stop"],
      ["start", "stop"],
      ["start", "stop"],
      ["start"],
    ]);
  });

  it("keeps the tenants of every key apart, and forgets those it disposed", async () => {
    const stopped: string[] = [];
    const declare = (key: string) =>
      createBounda({
        consistency: "eventual",
        key,
        tenant: tenantOfHeader,
        boot: async (args) => {
          const app = fakeApp(`${key}/${args?.tenant}`);
          return { ...app.app, stop: async () => void stopped.push(`${key}/${args?.tenant}`) };
        },
      });
    const [first, second] = [uniqueKey(), uniqueKey()];
    const one = declare(first);
    const other = declare(second);
    await one.boundaMiddleware(requestFor("acme").args, async () => undefined);
    await other.boundaMiddleware(requestFor("acme").args, async () => undefined);
    const again = declare(first);
    await drained();
    expect(stopped).toEqual([`${first}/acme`]);
    await again.dispose();
    await again.dispose();
    expect(stopped).toEqual([`${first}/acme`]);
    await other.dispose();
    expect(stopped).toEqual([`${first}/acme`, `${second}/acme`]);
  });

  it("logs as the errorText of a tenant's app once one has booted", async () => {
    const lines: unknown[][] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (...entry: unknown[]) => void lines.push(entry),
    };
    const { boundaMiddleware, dispose, handleError } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      tenant: tenantOfHeader,
      logger,
      errorText: "omit",
      boot: async (args) => {
        if (args?.tenant === "broken") throw new Error("broken does not boot");
        return {
          ...fakeApp("acme").app,
          config: { runtime: { telemetry: { errorText: "include" } } },
        } as unknown as BoundaApp;
      },
    });
    const failed = new Error("no account for ana@example.com");
    const request = new Request("http://localhost/accounts");
    await handleError(failed, { request });
    expect(lines.at(-1)?.[1]).not.toHaveProperty("errorMessage");
    // A tenant whose app did not boot has no rule: the one that booted gives it.
    await expect(
      boundaMiddleware(requestFor("broken").args, async () => undefined),
    ).rejects.toThrow("broken does not boot");
    await boundaMiddleware(requestFor("acme").args, async () => undefined);
    await handleError(failed, { request });
    expect(lines.at(-1)?.[1]).toMatchObject({ errorMessage: "no account for ana@example.com" });
    await dispose();
    await handleError(failed, { request });
    expect(lines.at(-1)?.[1]).not.toHaveProperty("errorMessage");
  });

  // Apps by tenant, recording when each stops.
  const pooled = (tenantApps: { readonly max?: number; readonly idleMs?: number }) => {
    const stopped: string[] = [];
    const booted: string[] = [];
    const { boundaMiddleware, dispose } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      tenant: tenantOfHeader,
      tenantApps,
      boot: async (args) => {
        const name = args?.tenant ?? "none";
        booted.push(name);
        return { ...fakeApp(name).app, stop: async () => void stopped.push(name) };
      },
    });
    const serve = (name: string, next: () => Promise<unknown> = async () => undefined) =>
      boundaMiddleware(requestFor(name).args, next);
    return { serve, dispose, stopped, booted };
  };

  it("keeps at most tenantApps.max apps, stopping the one served least recently", async () => {
    const pool = pooled({ max: 2 });
    await pool.serve("acme");
    await pool.serve("globex");
    await pool.serve("acme");
    await pool.serve("initech");
    await drained();
    expect(pool.stopped).toEqual(["globex"]);
    await pool.serve("globex");
    await drained();
    expect(pool.stopped).toEqual(["globex", "acme"]);
    expect(pool.booted).toEqual(["acme", "globex", "initech", "globex"]);
    await pool.dispose();
    expect([...pool.stopped].sort()).toEqual(["acme", "globex", "globex", "initech"]);
  });

  it("stops an app it lets go only once the requests it serves have ended", async () => {
    const pool = pooled({ max: 1 });
    let finish = (): void => {};
    const holding = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const serving = pool.serve("acme", () => holding);
    await drained();
    await pool.serve("globex");
    await drained();
    expect(pool.stopped).toEqual([]);
    finish();
    await serving;
    await drained();
    expect(pool.stopped).toEqual(["acme"]);
    await pool.dispose();
  });

  it("stops an app two requests share only once both have ended, and dispose waits for it", async () => {
    const pool = pooled({ max: 1 });
    const holds: (() => void)[] = [];
    const held = () =>
      new Promise<void>((resolve) => {
        holds.push(resolve);
      });
    const first = pool.serve("acme", held);
    const second = pool.serve("acme", held);
    await drained();
    await pool.serve("globex");
    holds[0]?.();
    await first;
    await drained();
    expect(pool.stopped).toEqual([]);
    const disposing = pool.dispose();
    await drained();
    expect(pool.stopped).toEqual(["globex"]);
    holds[1]?.();
    await second;
    await disposing;
    expect(pool.stopped).toEqual(["globex", "acme"]);
  });

  it("stops an app idle for tenantApps.idleMs at the next request of any tenant", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00.000Z") });
    try {
      const pool = pooled({ idleMs: 60_000 });
      await pool.serve("acme");
      vi.setSystemTime(new Date("2026-01-01T00:00:59.999Z"));
      await pool.serve("globex");
      await drained();
      expect(pool.stopped).toEqual([]);
      vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
      await pool.serve("globex");
      await drained();
      expect(pool.stopped).toEqual(["acme"]);
      // The tenant served now stays, however long it went without a request.
      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
      await pool.serve("globex");
      await drained();
      expect(pool.stopped).toEqual(["acme"]);
      expect(pool.booted).toEqual(["acme", "globex"]);
      await pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an app serving a request past its idle time, as long as the request runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00.000Z") });
    try {
      const pool = pooled({ idleMs: 60_000 });
      let finish = (): void => {};
      const serving = pool.serve(
        "acme",
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      await drained();
      vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
      await pool.serve("globex");
      await pool.serve("acme");
      finish();
      await serving;
      await drained();
      expect(pool.stopped).toEqual([]);
      expect(pool.booted).toEqual(["acme", "globex"]);
      await pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a bound of less than one app, or an idle time that is no duration", () => {
    expect(() =>
      createBounda({ key: uniqueKey(), tenant: tenantOfHeader, tenantApps: { idleMs: 0 } }),
    ).not.toThrow();
    expect(() =>
      createBounda({
        key: uniqueKey(),
        tenant: tenantOfHeader,
        tenantApps: { idleMs: "1m" as unknown as number },
      }),
    ).toThrow(
      new ConfigurationError("tenantApps.idleMs must be a duration in milliseconds, got 1m"),
    );
    for (const tenantApps of [{ max: 0 }, { max: 1.5 }, { idleMs: -1 }, { idleMs: Number.NaN }]) {
      expect(() => createBounda({ key: uniqueKey(), tenant: tenantOfHeader, tenantApps })).toThrow(
        ConfigurationError,
      );
    }
    expect(DEFAULT_TENANT_APPS).toBe(100);
    expect(DEFAULT_TENANT_IDLE_MS).toBe(15 * 60_000);
  });

  it("refuses a tenant that is no function, and a name that is no string", async () => {
    expect(() =>
      createBounda({ key: uniqueKey(), tenant: "acme" as unknown as () => string }),
    ).toThrow(
      new ConfigurationError(
        'tenant must be a function that names the store of a request, such as () => "default"',
      ),
    );
    const { boundaMiddleware } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      tenant: () => 42 as unknown as string,
      boot: async () => fakeApp("never").app,
    });
    await expect(boundaMiddleware(middlewareArgs().args, async () => undefined)).rejects.toThrow(
      new ConfigurationError(
        "tenant must name the store of a request with a non-empty string, got 42",
      ),
    );
  });
});

describe("createBounda's host log", () => {
  const requestOf = (headers: Record<string, string>, pattern = "/orders/:orderId") => {
    const context = new RouterContextProvider();
    return {
      context,
      args: { request: new Request(url, { headers }), url, pattern, params: {}, context },
    };
  };
  // An app whose `as` refuses an empty actor, as the runtime's does.
  const strictApp = (): BoundaApp =>
    ({
      ...fakeApp("strict").app,
      as: (actor: string) => {
        if (actor === "") throw new ValidationError("as needs the id of who acts", []);
        return fakeApp(actor).app;
      },
    }) as unknown as BoundaApp;
  const auditing = () => {
    const records: OnHostRejectionArgs[] = [];
    return {
      records,
      registry: {
        audit: {
          onPersonalDataAccess: () => {},
          onHostRejection: (args: OnHostRejectionArgs) => {
            records.push(args);
          },
        },
      },
    };
  };
  const signIn = new Response(null, { status: 302, headers: { location: "/sign-in" } });
  const actorOfHeader = ({ request }: { readonly request: Request }) => {
    const user = request.headers.get("x-user");
    if (user === null) throw signIn;
    return user;
  };

  it("records each request refused for its tenant or its actor in app/audit.ts, before it rejects", async () => {
    const { records, registry } = auditing();
    const { boundaMiddleware, dispose } = createBounda({
      consistency: "eventual",
      key: uniqueKey(),
      tenant: ({ request }) => {
        const tenant = request.headers.get("x-tenant");
        if (tenant === "none") throw new Error("no such workspace");
        return tenant ?? "";
      },
      actor: actorOfHeader,
      boot: async () => strictApp(),
      registry,
    });
    const next = async () => undefined;
    await expect(boundaMiddleware(requestOf({}).args, next)).rejects.toThrow(ConfigurationError);
    await expect(boundaMiddleware(requestOf({ "x-tenant": "none" }).args, next)).rejects.toThrow(
      "no such workspace",
    );
    await expect(boundaMiddleware(requestOf({ "x-tenant": "acme" }).args, next)).rejects.toBe(
      signIn,
    );
    await expect(
      boundaMiddleware(requestOf({ "x-tenant": "acme", "x-user": "" }).args, next),
    ).rejects.toThrow(ValidationError);
    await boundaMiddleware(requestOf({ "x-tenant": "acme", "x-user": "user-1" }).args, next);

    const refusal = (rejection: Omit<HostRejection, "at" | "target">) => ({
      rejection: { at: expect.any(String), target: "/orders/:orderId", ...rejection },
      env: process.env,
      logger: expect.anything(),
    });
    expect(records).toEqual([
      refusal({ tenant: null, reason: "tenant-unresolved", actor: null }),
      refusal({ tenant: null, reason: "tenant-unresolved", actor: null }),
      refusal({ tenant: "acme", reason: "actor-unresolved", actor: null }),
      refusal({ tenant: "acme", reason: "actor-invalid", actor: null }),
    ]);
    await dispose();
  });

  it("records a refused actor of the app every request shares under the tenant it serves", async () => {
    const { records, registry } = auditing();
    const { boundaMiddleware, dispose } = createBounda({
      key: uniqueKey(),
      actor: actorOfHeader,
      boot: async () => ({ ...strictApp(), tenant: "acme" }) as BoundaApp,
      registry,
    });
    await expect(boundaMiddleware(requestOf({}, "/").args, async () => undefined)).rejects.toBe(
      signIn,
    );
    expect(records.map(({ rejection }) => rejection)).toEqual([
      {
        at: expect.any(String),
        tenant: "acme",
        reason: "actor-unresolved",
        target: "/",
        actor: null,
      },
    ]);
    await dispose();
  });

  it("goes to the logger at info without app/audit.ts, and rejects with what app/audit.ts throws", async () => {
    const entries: unknown[][] = [];
    const logger = {
      ...silentLogger,
      info: (message: string, fields?: object) => {
        entries.push([message, fields]);
      },
    };
    const logged = createBounda({
      key: uniqueKey(),
      tenant: () => "",
      boot: async () => strictApp(),
      logger,
    });
    await expect(
      logged.boundaMiddleware(requestOf({}).args, async () => undefined),
    ).rejects.toThrow(ConfigurationError);
    expect(entries).toEqual([
      [
        "request refused",
        {
          at: expect.any(String),
          tenant: null,
          reason: "tenant-unresolved",
          target: "/orders/:orderId",
          actor: null,
        },
      ],
    ]);
    const down = createBounda({
      key: uniqueKey(),
      tenant: () => "",
      boot: async () => strictApp(),
      registry: {
        audit: {
          onPersonalDataAccess: () => {},
          onHostRejection: () => {
            throw new Error("audit sink down");
          },
        },
      },
    });
    await expect(down.boundaMiddleware(requestOf({}).args, async () => undefined)).rejects.toThrow(
      "audit sink down",
    );
  });
});

describe("createBounda's handleError", () => {
  const thrown = () => new Error("no account for ana@example.com");
  const request = () => new Request("http://localhost/accounts");
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
  const withErrorText = (errorText: "omit" | "include"): BoundaApp =>
    ({
      ...fakeApp("a").app,
      config: { runtime: { telemetry: { errorText } } },
    }) as unknown as BoundaApp;

  it("follows the booted app's errorText, and errorText before any app booted", async () => {
    const { lines, logger } = recording();
    let booting: BoundaApp = withErrorText("include");
    const { boundaMiddleware, dispose, handleError } = createBounda({
      boot: async () => booting,
      key: uniqueKey(),
      logger,
      errorText: "include",
    });
    await handleError(thrown(), { request: request() });
    expect(lines.at(-1)?.[1]).toMatchObject({ errorMessage: "no account for ana@example.com" });

    booting = withErrorText("omit");
    await boundaMiddleware(middlewareArgs().args, async () => undefined);
    await handleError(thrown(), { request: request() });
    expect(lines.at(-1)).toEqual(["request failed", { method: "GET", errorName: "Error" }]);
    await dispose();
  });

  it("omits the text before any app booted by default, also when the boot failed", async () => {
    const { lines, logger } = recording();
    const { boundaMiddleware, handleError } = createBounda({
      boot: async () => {
        throw thrown();
      },
      key: uniqueKey(),
      logger,
    });
    const failed = await boundaMiddleware(middlewareArgs().args, async () => undefined).catch(
      (error: unknown) => error,
    );
    await handleError(failed, { request: request() });
    expect(lines).toEqual([["request failed", { method: "GET", errorName: "Error" }]]);
  });

  it("follows BOUNDA_ERROR_TEXT before any app booted, as boot() would, over errorText", async () => {
    const { lines, logger } = recording();
    const { handleError } = createBounda({
      boot: async () => fakeApp("a").app,
      key: uniqueKey(),
      logger,
      errorText: "omit",
    });
    try {
      process.env.BOUNDA_ERROR_TEXT = "include";
      await handleError(thrown(), { request: request() });
      process.env.BOUNDA_ERROR_TEXT = "loud";
      await handleError(thrown(), { request: request() });
    } finally {
      delete process.env.BOUNDA_ERROR_TEXT;
    }
    expect(lines.map(([, fields]) => "errorMessage" in (fields as object))).toEqual([true, false]);
  });

  it("logs without waiting for a boot in flight, and forgets the rule of an app it disposed", async () => {
    const { lines, logger } = recording();
    let finish: (app: BoundaApp) => void = () => undefined;
    const pending = new Promise<BoundaApp>((resolve) => {
      finish = resolve;
    });
    const { boundaMiddleware, dispose, handleError } = createBounda({
      boot: () => pending,
      key: uniqueKey(),
      logger,
    });
    const booting = boundaMiddleware(middlewareArgs().args, async () => undefined);
    await handleError(thrown(), { request: request() });
    expect(lines).toHaveLength(1);
    finish(withErrorText("include"));
    await booting;
    await handleError(thrown(), { request: request() });
    expect(lines.at(-1)?.[1]).toMatchObject({ errorMessage: "no account for ana@example.com" });
    await dispose();
    await handleError(thrown(), { request: request() });
    expect(lines.at(-1)).toEqual(["request failed", { method: "GET", errorName: "Error" }]);
  });

  it("keeps no rule of a boot that finishes after it was disposed", async () => {
    const { lines, logger } = recording();
    let finish: (app: BoundaApp) => void = () => undefined;
    const { boundaMiddleware, dispose, handleError } = createBounda({
      boot: () =>
        new Promise<BoundaApp>((resolve) => {
          finish = resolve;
        }),
      key: uniqueKey(),
      logger,
    });
    const booting = boundaMiddleware(middlewareArgs().args, async () => undefined);
    await Promise.resolve();
    const disposed = dispose();
    finish(withErrorText("include"));
    await disposed;
    await booting;
    await handleError(thrown(), { request: request() });
    expect(lines).toEqual([["request failed", { method: "GET", errorName: "Error" }]]);
  });

  it("logs a line to the console by default, as boot() does", async () => {
    const written: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => void written.push(args));
    try {
      const { handleError } = createBounda({
        boot: async () => fakeApp("a").app,
        key: uniqueKey(),
      });
      await handleError(thrown(), { request: request() });
      await handleError(thrown(), { request: request() });
    } finally {
      spy.mockRestore();
    }
    expect(written).toEqual([
      ['[bounda] error request failed {"method":"GET","errorName":"Error"}'],
      ['[bounda] error request failed {"method":"GET","errorName":"Error"}'],
    ]);
  });
});

describe("createBounda given a witness", () => {
  const empty = { aggregates: {}, readModels: {} } as Registry;
  const bootWith =
    (given: (Witness | undefined)[]) =>
    async (args?: { readonly tenant?: string; readonly witness?: Witness }) => {
      given.push(args?.witness);
      return createApp({
        registry: empty,
        config: { storage: memory(), runtime: { telemetry: { errorText: "include" } } },
        ...(args?.witness === undefined ? {} : { witness: args.witness }),
      });
    };
  const searched = async (witness: Witness) =>
    (
      (await expectForgotten(witness, "c-1", { values: ["ana@example.com"] }).catch(
        (error: unknown) => error,
      )) as NotForgottenError
    ).found;

  it("hands it to every boot, and logs what a request throws through it", async () => {
    const witness = createWitness();
    const given: (Witness | undefined)[] = [];
    const { boundaMiddleware, handleError, dispose } = createBounda({
      key: uniqueKey(),
      boot: bootWith(given),
      logger: silentLogger,
      witness,
    });
    await boundaMiddleware(middlewareArgs().args, async () => undefined);
    await handleError(new Error("no account for ana@example.com"), {
      request: new Request("http://localhost/accounts"),
    });
    expect(given).toEqual([witness]);
    expect(await searched(witness)).toEqual(
      ["fields.errorMessage", "fields.errorStack"].map((field) => ({
        value: "ana@example.com",
        store: "logs",
        row: 'entry 2 (error "request failed")',
        field,
      })),
    );
    await dispose();
  });

  it("hands it to the boot of each tenant's app, and logs through it on the console by default", async () => {
    const witness = createWitness();
    const given: (Witness | undefined)[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { boundaMiddleware, handleError, dispose } = createBounda({
        key: uniqueKey(),
        tenant: () => "acme",
        boot: bootWith(given),
        witness,
      });
      await boundaMiddleware(middlewareArgs().args, async () => undefined);
      await handleError(new Error("no account for ana@example.com"), {
        request: new Request("http://localhost/accounts"),
      });
      expect(given).toEqual([witness]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await searched(witness)).map(({ store, field }) => `${store} ${field}`)).toEqual([
        "logs fields.errorMessage",
        "logs fields.errorStack",
      ]);
      await dispose();
    } finally {
      spy.mockRestore();
    }
  });

  it("boots without one, with the arguments it took before, when it is given none", async () => {
    const calls: unknown[] = [];
    const boot = async (args?: { readonly tenant?: string }) => {
      calls.push(args);
      return createApp({ registry: empty, config: { storage: memory() } });
    };
    const single = createBounda({ key: uniqueKey(), boot, logger: silentLogger });
    const tenants = createBounda({
      key: uniqueKey(),
      tenant: () => "acme",
      boot,
      logger: silentLogger,
    });
    for (const { boundaMiddleware } of [single, tenants]) {
      await boundaMiddleware(middlewareArgs().args, async () => undefined);
    }
    expect(calls).toStrictEqual([undefined, { tenant: "acme" }]);
    await single.dispose();
    await tenants.dispose();
  });
});
