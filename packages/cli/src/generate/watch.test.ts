import type { watch as watchDirectory } from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixedClock } from "@bounda-dev/core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { watchFromFirstRun, watchProject } from "./watch.ts";

const temporary: string[] = [];

const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-watch-"));
  temporary.push(root);
  await mkdir(join(root, "app/domain/order/+types"), { recursive: true });
  return root;
};

const drained = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const unheard = async (clock: ReturnType<typeof createFixedClock>, writes: number) => {
  for (let write = 0; write < writes; write += 1) {
    await vi.waitFor(() => expect(clock.pending()).toBe(1));
    clock.advance(50);
  }
};

const cookies = async (directory: string): Promise<string[]> =>
  (await readdir(directory)).filter((name) => name.startsWith(".bounda-watch-"));

const cookieIn = (directory: string): Promise<string> =>
  vi.waitFor(async () => {
    const [cookie] = await cookies(directory);
    if (cookie === undefined) throw new Error(`no cookie in ${directory} yet`);
    return cookie;
  });

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

type WatchEvent = { readonly filename: string | Buffer | null };

interface WatchOptions {
  readonly recursive?: boolean;
  readonly signal?: AbortSignal;
}

interface FakeWatcher {
  readonly watch: typeof watchDirectory;
  readonly emit: (filename: string | null) => void;
  readonly end: (error?: Error) => void;
  readonly hearCookie: () => Promise<string>;
  readonly calls: { path: string; options: WatchOptions }[];
}

const abortError = (): Error => {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
};

const fakeWatcher = (): FakeWatcher => {
  const queue: (WatchEvent | { readonly error: Error | undefined })[] = [];
  let wake: (() => void) | undefined;
  const push = (item: (typeof queue)[number]) => {
    queue.push(item);
    wake?.();
  };
  const calls: FakeWatcher["calls"] = [];
  async function* events(): AsyncGenerator<WatchEvent> {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      if ("error" in next) {
        if (next.error === undefined) return;
        throw next.error;
      }
      yield next;
    }
  }
  const emit = (filename: string | null) => push({ filename });
  return {
    watch: ((path: string, options: WatchOptions) => {
      calls.push({ path, options });
      options.signal?.addEventListener("abort", () => push({ error: abortError() }), {
        once: true,
      });
      return events();
    }) as unknown as typeof watchDirectory,
    emit,
    end: (error) => push({ error }),
    hearCookie: async () => {
      const cookie = await cookieIn(calls[0]?.path ?? "");
      emit(cookie);
      return cookie;
    },
    calls,
  };
};

const start = async (
  watcher: FakeWatcher,
  overrides: { readonly appDir?: string; readonly throwOn?: number } = {},
) => {
  const root = await project();
  let runs = 0;
  let listened = 0;
  let unconfirmed = 0;
  const errors: unknown[] = [];
  const controller = new AbortController();
  const clock = createFixedClock();
  const watching = watchProject({
    root,
    ...(overrides.appDir === undefined ? {} : { appDir: overrides.appDir }),
    signal: controller.signal,
    debounceMs: 10,
    clock,
    watch: watcher.watch,
    onChange: async () => {
      runs += 1;
      if (runs === overrides.throwOn) throw new Error("boom");
    },
    onError: (error) => errors.push(error),
    onListening: () => {
      listened += 1;
    },
    onUnconfirmed: () => {
      unconfirmed += 1;
    },
  });
  return {
    root,
    watching,
    controller,
    clock,
    runs: () => runs,
    listened: () => listened,
    unconfirmed: () => unconfirmed,
    errors,
  };
};

const harness = async (
  watcher: FakeWatcher,
  overrides: { readonly appDir?: string; readonly throwOn?: number } = {},
) => {
  const started = await start(watcher, overrides);
  await watcher.hearCookie();
  await vi.waitFor(() => expect(started.listened()).toBe(1));
  return started;
};

describe("watchProject", () => {
  it("watches <root>/<appDir> recursively until the signal aborts, app/ by default", async () => {
    const watcher = fakeWatcher();
    const { root, watching, controller } = await start(watcher);
    expect(watcher.calls[0]?.path).toBe(join(root, "app"));
    expect(watcher.calls[0]?.options.recursive).toBe(true);
    expect(watcher.calls[0]?.options.signal?.aborted).toBe(false);
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
    expect(watcher.calls[0]?.options.signal?.aborted).toBe(true);

    const custom = fakeWatcher();
    const other = await project();
    await mkdir(join(other, "src"));
    const watchingCustom = watchProject({
      root: other,
      appDir: "src",
      signal: new AbortController().signal,
      watch: custom.watch,
      onChange: async () => undefined,
    });
    expect(custom.calls[0]?.path).toBe(join(other, "src"));
    await custom.hearCookie();
    custom.end(abortError());
    await watchingCustom;
  });

  it("writes a cookie until it hears it back, removes it, and then says it is listening", async () => {
    const watcher = fakeWatcher();
    const { root, watching, controller, clock, runs, listened } = await start(watcher);
    const app = join(root, "app");
    const cookie = await cookieIn(app);
    expect(cookie).toMatch(/^\.bounda-watch-[0-9a-f-]{36}$/);
    await vi.waitFor(() => expect(clock.pending()).toBe(1));
    await rm(join(app, cookie));
    clock.advance(49);
    await drained();
    expect(await cookies(app)).toEqual([]);
    clock.advance(1);
    await vi.waitFor(() => stat(join(app, cookie)));
    expect(listened()).toBe(0);

    watcher.emit(cookie);
    await vi.waitFor(() => expect(listened()).toBe(1));
    expect(await cookies(app)).toEqual([]);
    expect(clock.pending()).toBe(0);
    watcher.emit(cookie);
    await drained();
    expect(clock.pending()).toBe(0);
    expect(listened()).toBe(1);
    expect(runs()).toBe(0);
    controller.abort();
    await watching;
  });

  it("gives each watch a cookie of its own", async () => {
    const root = await project();
    const controller = new AbortController();
    const watchings = [fakeWatcher(), fakeWatcher()].map((watcher) =>
      watchProject({
        root,
        signal: controller.signal,
        watch: watcher.watch,
        onChange: async () => undefined,
      }),
    );
    await vi.waitFor(async () => expect(await cookies(join(root, "app"))).toHaveLength(2));
    controller.abort();
    await Promise.all(watchings);
  });

  it("removes the cookie and does not say it is listening when it ends first", async () => {
    const watcher = fakeWatcher();
    const { root, watching, controller, clock, listened } = await start(watcher);
    const app = join(root, "app");
    await cookieIn(app);
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
    expect(await cookies(app)).toEqual([]);
    expect(clock.pending()).toBe(0);
    expect(listened()).toBe(0);
  });

  it("gives up after 20 writes without hearing the cookie, and goes on watching", async () => {
    const watcher = fakeWatcher();
    const { root, watching, controller, clock, runs, listened, unconfirmed } = await start(watcher);
    const app = join(root, "app");
    const cookie = await cookieIn(app);
    await unheard(clock, 19);
    await vi.waitFor(() => expect(clock.pending()).toBe(1));
    expect(unconfirmed()).toBe(0);
    clock.advance(50);
    await vi.waitFor(() => expect(unconfirmed()).toBe(1));
    expect(await cookies(app)).toEqual([]);
    expect(clock.pending()).toBe(0);
    expect(listened()).toBe(0);

    watcher.emit(cookie);
    await drained();
    expect(clock.pending()).toBe(0);
    watcher.emit("domain/order/a.ts");
    await drained();
    clock.advance(10);
    await vi.waitFor(() => expect(runs()).toBe(1));
    expect(listened()).toBe(0);
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
  });

  it("ends and rejects when the cookie cannot be written", async () => {
    const watcher = fakeWatcher();
    const { watching, listened } = await start(watcher, { appDir: "missing" });
    await expect(watching).rejects.toMatchObject({ code: "ENOENT" });
    expect(watcher.calls[0]?.options.signal?.aborted).toBe(true);
    expect(listened()).toBe(0);
  });

  it("does not report a cookie it could not write once it has ended", async () => {
    const watcher = fakeWatcher();
    const { watching, controller } = await start(watcher, { appDir: "missing" });
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
  });

  it("says it is listening even when the cookie is gone by the time it hears it", async () => {
    const watcher = fakeWatcher();
    const { root, watching, controller, listened } = await start(watcher);
    const app = join(root, "app");
    const cookie = await cookieIn(app);
    await rm(join(app, cookie));
    watcher.emit(cookie);
    await vi.waitFor(() => expect(listened()).toBe(1));
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
  });

  it("passes what onListening throws to onError and keeps watching", async () => {
    const watcher = fakeWatcher();
    const errors: unknown[] = [];
    let runs = 0;
    const clock = createFixedClock();
    const controller = new AbortController();
    const watching = watchProject({
      root: await project(),
      signal: controller.signal,
      debounceMs: 10,
      clock,
      watch: watcher.watch,
      onChange: async () => {
        runs += 1;
      },
      onError: (error) => errors.push(error),
      onListening: () => {
        throw new Error("boom");
      },
    });
    await watcher.hearCookie();
    await vi.waitFor(() => expect(errors).toEqual([new Error("boom")]));
    watcher.emit("domain/order/a.ts");
    await drained();
    clock.advance(10);
    await vi.waitFor(() => expect(runs).toBe(1));
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
  });

  it("coalesces a burst into one onChange and ignores +types", async () => {
    const watcher = fakeWatcher();
    const { watching, runs, clock } = await harness(watcher);
    watcher.emit("domain/order/a.ts");
    watcher.emit("domain/order/b.ts");
    watcher.emit(null);
    await drained();
    expect(clock.pending()).toBe(1);
    clock.advance(9);
    expect(clock.pending()).toBe(1);
    clock.advance(1);
    await vi.waitFor(() => expect(runs()).toBe(1));
    expect(clock.pending()).toBe(0);

    watcher.emit("domain/order/+types/a.ts");
    watcher.emit("domain/order/commands/+types/b.ts");
    await drained();
    expect(clock.pending()).toBe(0);

    watcher.emit("domain\\order\\c.ts");
    await drained();
    clock.advance(10);
    await vi.waitFor(() => expect(runs()).toBe(2));
    watcher.end(abortError());
    await expect(watching).resolves.toBeUndefined();
  });

  it("reports what onChange throws and keeps watching", async () => {
    const watcher = fakeWatcher();
    const { watching, runs, errors, clock } = await harness(watcher, { throwOn: 1 });
    watcher.emit("domain/order/a.ts");
    await drained();
    clock.advance(10);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toEqual(new Error("boom"));
    watcher.emit("domain/order/b.ts");
    await drained();
    clock.advance(10);
    await vi.waitFor(() => expect(runs()).toBe(2));
    expect(errors).toHaveLength(1);
    watcher.end(abortError());
    await watching;
  });

  it("stops on abort without running a pending change", async () => {
    const watcher = fakeWatcher();
    const { watching, runs, clock } = await harness(watcher);
    watcher.emit("domain/order/a.ts");
    await drained();
    expect(clock.pending()).toBe(1);
    watcher.end(abortError());
    await expect(watching).resolves.toBeUndefined();
    expect(clock.pending()).toBe(0);
    clock.advance(10);
    expect(runs()).toBe(0);
  });

  it("waits for a change in flight before it ends on abort", async () => {
    const watcher = fakeWatcher();
    const clock = createFixedClock();
    const release = Promise.withResolvers<void>();
    const timeline: string[] = [];
    const watching = watchProject({
      root: await project(),
      signal: new AbortController().signal,
      debounceMs: 10,
      clock,
      watch: watcher.watch,
      onChange: async () => {
        timeline.push("started");
        await release.promise;
        timeline.push("finished");
      },
    });
    await watcher.hearCookie();
    await vi.waitFor(() => expect(clock.pending()).toBe(0));
    watcher.emit("domain/order/a.ts");
    await drained();
    clock.advance(10);
    await drained();
    expect(timeline).toEqual(["started"]);
    const ended = watching.then(() => timeline.push("ended"));
    watcher.end(abortError());
    await drained();
    expect(timeline).toEqual(["started"]);
    release.resolve();
    await ended;
    expect(timeline).toEqual(["started", "finished", "ended"]);
  });

  it("rethrows a failure of the watcher itself", async () => {
    const watcher = fakeWatcher();
    const { root, watching } = await start(watcher);
    await cookieIn(join(root, "app"));
    watcher.end(new Error("disk gone"));
    await expect(watching).rejects.toThrow("disk gone");
    expect(await cookies(join(root, "app"))).toEqual([]);
  });

  it("sees a change made right after it says it is listening, on the real file system", async () => {
    const root = await project();
    let runs = 0;
    const controller = new AbortController();
    const listening = Promise.withResolvers<void>();
    const watching = watchProject({
      root,
      signal: controller.signal,
      debounceMs: 50,
      onChange: async () => {
        runs += 1;
      },
      onListening: listening.resolve,
    });
    await listening.promise;
    expect(await cookies(join(root, "app"))).toEqual([]);
    await writeFile(join(root, "app/domain/order/a.ts"), "export {};\n");
    await vi.waitFor(() => expect(runs).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
  }, 15_000);
});

describe("watchFromFirstRun", () => {
  const begin = async (watcher: FakeWatcher, firstRun: () => Promise<boolean>) => {
    const controller = new AbortController();
    const clock = createFixedClock();
    let changes = 0;
    let announced = 0;
    let firstRuns = 0;
    let unconfirmed = 0;
    const done = watchFromFirstRun({
      root: await project(),
      signal: controller.signal,
      debounceMs: 10,
      clock,
      watch: watcher.watch,
      firstRun: () => {
        firstRuns += 1;
        return firstRun();
      },
      onChange: async () => {
        changes += 1;
      },
      onUnconfirmed: () => {
        unconfirmed += 1;
      },
      onWatching: () => {
        announced += 1;
      },
    });
    return {
      done,
      controller,
      clock,
      changes: () => changes,
      announced: () => announced,
      firstRuns: () => firstRuns,
      unconfirmed: () => unconfirmed,
    };
  };

  const listening = async (watcher: FakeWatcher, run: { readonly firstRuns: () => number }) => {
    await watcher.hearCookie();
    await vi.waitFor(() => expect(run.firstRuns()).toBe(1));
  };

  it("makes the first run once the watcher is listening, and announces once it goes on", async () => {
    const watcher = fakeWatcher();
    const run = await begin(watcher, async () => true);
    await cookieIn(watcher.calls[0]?.path ?? "");
    await drained();
    expect(run.firstRuns()).toBe(0);
    await listening(watcher, run);
    await vi.waitFor(() => expect(run.announced()).toBe(1));
    run.controller.abort();
    await expect(run.done).resolves.toBeUndefined();
  });

  it("holds a change made during the first run until that run is done", async () => {
    const watcher = fakeWatcher();
    const first = Promise.withResolvers<boolean>();
    const run = await begin(watcher, () => first.promise);
    await listening(watcher, run);
    watcher.emit("domain/order/a.ts");
    await drained();
    run.clock.advance(10);
    await drained();
    expect(run.clock.pending()).toBe(0);
    expect(run.changes()).toBe(0);
    first.resolve(true);
    await vi.waitFor(() => expect(run.changes()).toBe(1));
    run.controller.abort();
    await run.done;
  });

  it("ends at once when the first run does not go on, dropping the change it held", async () => {
    const watcher = fakeWatcher();
    const first = Promise.withResolvers<boolean>();
    const run = await begin(watcher, () => first.promise);
    await listening(watcher, run);
    watcher.emit("domain/order/a.ts");
    await drained();
    run.clock.advance(10);
    await drained();
    first.resolve(false);
    await expect(run.done).resolves.toBeUndefined();
    expect(run.announced()).toBe(0);
    expect(run.changes()).toBe(0);
  });

  it("ends the watch and rethrows when the first run rejects", async () => {
    const watcher = fakeWatcher();
    const run = await begin(watcher, async () => {
      throw new Error("boom");
    });
    const rejected = expect(run.done).rejects.toThrow("boom");
    await listening(watcher, run);
    await rejected;
    expect(run.announced()).toBe(0);
    expect(watcher.calls[0]?.options.signal?.aborted).toBe(true);
  });

  it("reports a watcher that fails during the first run once that run is done", async () => {
    const watcher = fakeWatcher();
    const first = Promise.withResolvers<boolean>();
    const run = await begin(watcher, () => first.promise);
    await listening(watcher, run);
    watcher.end(new Error("disk gone"));
    await drained();
    first.resolve(true);
    await expect(run.done).rejects.toThrow("disk gone");
  });

  it("makes no first run when the signal aborts before the watcher is listening", async () => {
    const watcher = fakeWatcher();
    const run = await begin(watcher, async () => true);
    await cookieIn(watcher.calls[0]?.path ?? "");
    run.controller.abort();
    await expect(run.done).resolves.toBeUndefined();
    expect(run.firstRuns()).toBe(0);
    expect(run.announced()).toBe(0);
  });

  it("makes the first run once the watcher gives up confirming it is listening", async () => {
    const watcher = fakeWatcher();
    const run = await begin(watcher, async () => true);
    await unheard(run.clock, 19);
    await vi.waitFor(() => expect(run.clock.pending()).toBe(1));
    expect(run.firstRuns()).toBe(0);
    run.clock.advance(50);
    await vi.waitFor(() => expect(run.announced()).toBe(1));
    expect(run.unconfirmed()).toBe(1);
    expect(run.firstRuns()).toBe(1);
    run.controller.abort();
    await expect(run.done).resolves.toBeUndefined();
  });

  it("still makes the first run when the watcher fails before it listens, then rethrows", async () => {
    const watcher = fakeWatcher();
    const run = await begin(watcher, async () => true);
    await cookieIn(watcher.calls[0]?.path ?? "");
    watcher.end(new Error("disk gone"));
    await expect(run.done).rejects.toThrow("disk gone");
    expect(run.firstRuns()).toBe(1);
  });
});
