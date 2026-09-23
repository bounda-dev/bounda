import type { watch as watchDirectory } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  readonly calls: { path: string; options: WatchOptions }[];
  readonly listening: () => boolean;
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
  let listening = false;
  async function* events(): AsyncGenerator<WatchEvent> {
    listening = true;
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
  return {
    watch: ((path: string, options: WatchOptions) => {
      calls.push({ path, options });
      options.signal?.addEventListener("abort", () => push({ error: abortError() }), {
        once: true,
      });
      return events();
    }) as unknown as typeof watchDirectory,
    emit: (filename) => push({ filename }),
    end: (error) => push({ error }),
    calls,
    listening: () => listening,
  };
};

const harness = (
  watcher: FakeWatcher,
  overrides: { readonly appDir?: string; readonly throwOn?: number } = {},
) => {
  let runs = 0;
  const errors: unknown[] = [];
  const controller = new AbortController();
  const clock = createFixedClock();
  const watching = watchProject({
    root: "/project",
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
  });
  return { watching, controller, clock, runs: () => runs, errors };
};

describe("watchProject", () => {
  it("watches <root>/<appDir> recursively with the signal, app/ by default", async () => {
    const watcher = fakeWatcher();
    const { watching, controller } = harness(watcher);
    expect(watcher.calls[0]?.path).toBe(join("/project", "app"));
    expect(watcher.calls[0]?.options).toEqual({ recursive: true, signal: controller.signal });
    watcher.end(abortError());
    await watching;

    const custom = fakeWatcher();
    const { watching: watchingCustom } = harness(custom, { appDir: "src" });
    expect(custom.calls[0]?.path).toBe(join("/project", "src"));
    custom.end(abortError());
    await watchingCustom;
  });

  it("is listening by the time it returns", async () => {
    const watcher = fakeWatcher();
    const { watching } = harness(watcher);
    expect(watcher.listening()).toBe(true);
    watcher.end(abortError());
    await watching;
  });

  it("coalesces a burst into one onChange and ignores +types", async () => {
    const watcher = fakeWatcher();
    const { watching, runs, clock } = harness(watcher);
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
    const { watching, runs, errors, clock } = harness(watcher, { throwOn: 1 });
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
    const { watching, runs, clock } = harness(watcher);
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
      root: "/project",
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
    const { watching } = harness(watcher);
    watcher.end(new Error("disk gone"));
    await expect(watching).rejects.toThrow("disk gone");
  });

  it("sees a change made right after it returns, on the real file system", async () => {
    const root = await project();
    let runs = 0;
    const controller = new AbortController();
    const watching = watchProject({
      root,
      signal: controller.signal,
      debounceMs: 50,
      onChange: async () => {
        runs += 1;
      },
    });
    await writeFile(join(root, "app/domain/order/a.ts"), "export {};\n");
    await vi.waitFor(() => expect(runs).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
  }, 15_000);
});

describe("watchFromFirstRun", () => {
  const start = (watcher: FakeWatcher, firstRun: () => Promise<boolean>) => {
    const controller = new AbortController();
    const clock = createFixedClock();
    let changes = 0;
    let announced = 0;
    let listeningAtFirstRun: boolean | undefined;
    const done = watchFromFirstRun({
      root: "/project",
      signal: controller.signal,
      debounceMs: 10,
      clock,
      watch: watcher.watch,
      firstRun: () => {
        listeningAtFirstRun ??= watcher.listening();
        return firstRun();
      },
      onChange: async () => {
        changes += 1;
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
      listeningAtFirstRun: () => listeningAtFirstRun,
    };
  };

  it("is listening before the first run starts, and announces once that run goes on", async () => {
    const watcher = fakeWatcher();
    const run = start(watcher, async () => true);
    await vi.waitFor(() => expect(run.announced()).toBe(1));
    expect(run.listeningAtFirstRun()).toBe(true);
    run.controller.abort();
    await expect(run.done).resolves.toBeUndefined();
  });

  it("holds a change made during the first run until that run is done", async () => {
    const watcher = fakeWatcher();
    const first = Promise.withResolvers<boolean>();
    const run = start(watcher, () => first.promise);
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
    const run = start(watcher, () => first.promise);
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
    const run = start(watcher, async () => {
      throw new Error("boom");
    });
    await expect(run.done).rejects.toThrow("boom");
    expect(run.announced()).toBe(0);
    expect(watcher.calls[0]?.options.signal?.aborted).toBe(true);
  });

  it("reports a watcher that fails during the first run once that run is done", async () => {
    const watcher = fakeWatcher();
    const first = Promise.withResolvers<boolean>();
    const run = start(watcher, () => first.promise);
    watcher.end(new Error("disk gone"));
    await drained();
    first.resolve(true);
    await expect(run.done).rejects.toThrow("disk gone");
  });
});
