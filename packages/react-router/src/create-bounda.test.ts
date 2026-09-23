import type { BoundaApp } from "@bounda-dev/core";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { createBounda } from "./create-bounda.ts";

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

describe("createBounda", () => {
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
    await served.stop();
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
