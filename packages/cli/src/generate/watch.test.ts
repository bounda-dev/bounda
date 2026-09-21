import type { watch as watchDirectory } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { watchProject } from "./watch.ts";

const temporary: string[] = [];

const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-watch-"));
  temporary.push(root);
  await mkdir(join(root, "app/domain/order/+types"), { recursive: true });
  return root;
};

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (condition: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await settle(20);
};

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

type WatchEvent = { readonly filename: string | Buffer | null };

interface FakeWatcher {
  readonly watch: typeof watchDirectory;
  readonly emit: (filename: string | null) => void;
  readonly end: (error?: Error) => void;
  readonly calls: { path: string; options: unknown }[];
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
  return {
    watch: ((path: string, options: unknown) => {
      calls.push({ path, options });
      return events();
    }) as unknown as typeof watchDirectory,
    emit: (filename) => push({ filename }),
    end: (error) => push({ error }),
    calls,
  };
};

const harness = (
  watcher: FakeWatcher,
  overrides: { readonly appDir?: string; readonly throwOn?: number } = {},
) => {
  let runs = 0;
  const errors: unknown[] = [];
  const controller = new AbortController();
  const watching = watchProject({
    root: "/project",
    ...(overrides.appDir === undefined ? {} : { appDir: overrides.appDir }),
    signal: controller.signal,
    debounceMs: 10,
    watch: watcher.watch,
    onChange: async () => {
      runs += 1;
      if (runs === overrides.throwOn) throw new Error("boom");
    },
    onError: (error) => errors.push(error),
  });
  return { watching, controller, runs: () => runs, errors };
};

describe("watchProject", () => {
  it("watches <root>/<appDir> recursively with the signal, app/ by default", async () => {
    const watcher = fakeWatcher();
    const { watching, controller } = harness(watcher);
    await until(() => watcher.calls.length === 1);
    expect(watcher.calls[0]?.path).toBe(join("/project", "app"));
    expect(watcher.calls[0]?.options).toEqual({ recursive: true, signal: controller.signal });
    watcher.end(abortError());
    await watching;

    const custom = fakeWatcher();
    const { watching: watchingCustom } = harness(custom, { appDir: "src" });
    await until(() => custom.calls.length === 1);
    expect(custom.calls[0]?.path).toBe(join("/project", "src"));
    custom.end(abortError());
    await watchingCustom;
  });

  it("coalesces a burst into one onChange and ignores +types", async () => {
    const watcher = fakeWatcher();
    const { watching, runs } = harness(watcher);
    watcher.emit("domain/order/a.ts");
    watcher.emit("domain/order/b.ts");
    watcher.emit(null);
    await until(() => runs() === 1);
    await settle(60);
    expect(runs()).toBe(1);

    watcher.emit("domain/order/+types/a.ts");
    watcher.emit("domain/order/commands/+types/b.ts");
    await settle(60);
    expect(runs()).toBe(1);

    watcher.emit("domain\\order\\c.ts");
    await until(() => runs() === 2);
    watcher.end(abortError());
    await expect(watching).resolves.toBeUndefined();
  });

  it("reports what onChange throws and keeps watching", async () => {
    const watcher = fakeWatcher();
    const { watching, runs, errors } = harness(watcher, { throwOn: 1 });
    watcher.emit("domain/order/a.ts");
    await until(() => errors.length === 1);
    expect(errors[0]).toEqual(new Error("boom"));
    watcher.emit("domain/order/b.ts");
    await until(() => runs() === 2);
    expect(errors).toHaveLength(1);
    watcher.end(abortError());
    await watching;
  });

  it("stops on abort without running a pending change, and waits for one in flight", async () => {
    const watcher = fakeWatcher();
    const { watching, runs } = harness(watcher);
    watcher.emit("domain/order/a.ts");
    watcher.end(abortError());
    await expect(watching).resolves.toBeUndefined();
    await settle(60);
    expect(runs()).toBe(0);
  });

  it("rethrows a failure of the watcher itself", async () => {
    const watcher = fakeWatcher();
    const { watching } = harness(watcher);
    watcher.end(new Error("disk gone"));
    await expect(watching).rejects.toThrow("disk gone");
  });

  it("works on the real file system", async () => {
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
    await settle(150);
    await writeFile(join(root, "app/domain/order/a.ts"), "export {};\n");
    await until(() => runs >= 1);
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
  });
});
