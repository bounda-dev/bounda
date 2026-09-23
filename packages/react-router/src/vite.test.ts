import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFixedClock, type FixedClock } from "@bounda-dev/core";
import type { Logger, Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { bounda } from "./vite.ts";
import { createBoundaPlugin } from "./vite-plugin.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixtures = join(repoRoot, "packages/core/test-types/fixtures");
const temporary: string[] = [];

afterAll(async () => {
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })));
});

const project = async (fixture = "order-app-inferred"): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-vite-"));
  temporary.push(root);
  await cp(join(fixtures, fixture, "app"), join(root, "app"), {
    recursive: true,
    filter: (source) => !source.includes("/+types"),
  });
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: join(repoRoot, "tsconfig.base.json"),
      compilerOptions: {
        isolatedDeclarations: false,
        declaration: false,
        types: [],
        paths: { "@bounda-dev/core": [join(repoRoot, "packages/core/src/index.ts")] },
      },
      include: [".", ".bounda/**/*"],
    }),
  );
  return root;
};

interface Recorded {
  readonly logger: Logger;
  readonly warnings: string[];
  readonly errors: string[];
}

const recordingLogger = (): Recorded => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger = {
    info: () => undefined,
    warn: (message: string) => void warnings.push(message),
    warnOnce: (message: string) => void warnings.push(message),
    error: (message: string) => void errors.push(message),
    clearScreen: () => undefined,
    hasErrorLogged: () => false,
    hasWarned: false,
  } as unknown as Logger;
  return { logger, warnings, errors };
};

type Hook<Name extends keyof Plugin> = Extract<Plugin[Name], (...args: never[]) => unknown>;

const hookOf = <Name extends keyof Plugin>(plugin: Plugin, name: Name): Hook<Name> => {
  const hook = plugin[name];
  return (typeof hook === "function" ? hook : (hook as { handler: unknown }).handler) as Hook<Name>;
};

interface Harness {
  readonly plugin: Plugin;
  readonly recorded: Recorded;
  readonly configure: (command: "serve" | "build") => void;
  readonly start: () => Promise<void>;
  readonly load: (id: string, consumer: "client" | "server") => unknown;
  readonly resolve: (id: string) => unknown;
  readonly serve: () => EventEmitter;
  readonly close: () => Promise<void>;
  readonly clock: FixedClock;
}

const harness = (root: string, options?: Parameters<typeof bounda>[0]): Harness => {
  const clock = createFixedClock();
  const plugin = createBoundaPlugin({ ...options, clock });
  const recorded = recordingLogger();
  return {
    plugin,
    recorded,
    clock,
    close: async () => {
      const closeBundle = hookOf(plugin, "closeBundle") as (this: unknown) => Promise<void>;
      await closeBundle.call({});
    },
    configure: (command) => {
      const configResolved = hookOf(plugin, "configResolved") as (
        this: unknown,
        config: ResolvedConfig,
      ) => void;
      configResolved.call({}, { root, command, logger: recorded.logger } as ResolvedConfig);
    },
    start: async () => {
      const buildStart = hookOf(plugin, "buildStart") as (this: unknown) => Promise<void>;
      await buildStart.call({});
    },
    load: (id, consumer) => {
      const load = hookOf(plugin, "load") as (this: unknown, id: string) => unknown;
      return load.call({ environment: { config: { consumer } } }, id);
    },
    resolve: (id) => {
      const resolveId = hookOf(plugin, "resolveId") as (this: unknown, id: string) => unknown;
      return resolveId.call({}, id);
    },
    serve: () => {
      const watcher = new EventEmitter();
      const configureServer = hookOf(plugin, "configureServer") as (
        this: unknown,
        server: ViteDevServer,
      ) => void;
      configureServer.call({}, { watcher } as unknown as ViteDevServer);
      return watcher;
    },
  };
};

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const until = async (condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await settle(25);
  }
};

describe("bounda() Vite plugin", () => {
  it("resolves the app module and nothing else, before Vite's own resolver", () => {
    const { plugin, resolve: resolveId } = harness("/project");
    expect(plugin.name).toBe("bounda");
    expect(plugin.enforce).toBe("pre");
    expect(resolveId("@bounda-dev/react-router/app")).toBe("\0@bounda-dev/react-router/app");
    expect(resolveId("@bounda-dev/react-router")).toBeNull();
    expect(resolveId("./app.ts")).toBeNull();
  });

  it("keeps the package inside the server bundle and out of the client pre-bundle", () => {
    const plugin = bounda();
    const configEnvironment = hookOf(plugin, "configEnvironment") as unknown as (
      this: unknown,
      name: string,
    ) => {
      readonly resolve?: { readonly noExternal?: readonly RegExp[] };
      readonly optimizeDeps?: { readonly exclude?: readonly string[] };
    };
    const server = configEnvironment.call({}, "ssr");
    const pattern = server.resolve?.noExternal?.[0] as RegExp;
    expect(pattern.test("@bounda-dev/react-router/app")).toBe(true);
    expect(pattern.test("@bounda-dev/react-router")).toBe(true);
    expect(pattern.test("@bounda-dev/react-router-other")).toBe(false);
    expect(pattern.test("not-@bounda-dev/react-router")).toBe(false);
    expect(configEnvironment.call({}, "client").optimizeDeps?.exclude).toEqual([
      "@bounda-dev/react-router",
    ]);
    expect(configEnvironment.call({}, "client").resolve).toBeUndefined();
  });

  it("serves the server module wired to the project's registry, reading its own writes", () => {
    const { configure, load } = harness("/project");
    configure("serve");
    const code = load("\0@bounda-dev/react-router/app", "server");
    expect(code).toBe(
      [
        'import { boot } from "@bounda-dev/core/node";',
        'import { createBounda } from "@bounda-dev/react-router";',
        'import { registry } from "/project/.bounda/registry.ts";',
        "",
        "export const { bounda, boundaMiddleware, dispose } = createBounda({",
        '  boot: () => boot({ root: "/project", registry }),',
        '  consistency: "immediate",',
        "});",
        "",
      ].join("\n"),
    );
    expect(load("\0other", "server")).toBeNull();
  });

  it("passes the consistency option through", () => {
    const { configure, load } = harness("/project", { consistency: "eventual" });
    configure("serve");
    expect(load("\0@bounda-dev/react-router/app", "server")).toContain('consistency: "eventual"');
  });

  it("serves the client a stub that fails loudly when touched", async () => {
    const { configure, load } = harness("/project");
    configure("serve");
    const code = load("\0@bounda-dev/react-router/app", "client") as string;
    expect(code).toBe(
      [
        "const serverOnly = () => {",
        '  throw new Error("@bounda-dev/react-router/app is server-only: use it in loaders, actions and middleware, not in components");',
        "};",
        "export const bounda = new Proxy({}, { get: serverOnly });",
        "export const boundaMiddleware = serverOnly;",
        "export const dispose = serverOnly;",
        "",
      ].join("\n"),
    );
    const module = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as {
      bounda: { defaultValue?: unknown };
      boundaMiddleware: () => unknown;
    };
    expect(() => module.bounda.defaultValue).toThrow("server-only");
    expect(() => module.boundaMiddleware()).toThrow("server-only");
  });

  it("serves nothing before the config is resolved", () => {
    const { load } = harness("/project");
    expect(load("\0@bounda-dev/react-router/app", "server")).toBeNull();
  });

  it("generates the project when the build starts and reports inference warnings", async () => {
    const root = await project();
    const { configure, start, recorded } = harness(root);
    configure("serve");
    await start();
    expect(await exists(join(root, ".bounda/registry.ts"))).toBe(true);
    expect(await exists(join(root, ".bounda/register.d.ts"))).toBe(true);
    expect(await exists(join(root, "app/domain/order/+types/order-placed.ts"))).toBe(true);
    expect(recorded.warnings.join("\n")).toContain("[bounda] warning: order:");
    expect(recorded.errors).toEqual([]);
  });

  it("stays quiet when there is nothing to warn about", async () => {
    const root = await project("order-app");
    const { configure, start, recorded } = harness(root);
    configure("serve");
    await start();
    expect(await exists(join(root, ".bounda/registry.ts"))).toBe(true);
    expect(recorded.warnings).toEqual([]);
    expect(recorded.errors).toEqual([]);
  });

  it("does nothing at build start before the config is resolved", async () => {
    const root = await project();
    const { start } = harness(root);
    await start();
    expect(await exists(join(root, ".bounda/registry.ts"))).toBe(false);
  });

  it("logs convention problems in dev and fails the build with them", async () => {
    const root = await project();
    await writeFile(join(root, "app/domain/order/BadName.ts"), "export {};\n");
    const dev = harness(root);
    dev.configure("serve");
    await dev.start();
    expect(dev.recorded.errors.join("\n")).toContain("app/domain/order/BadName.ts");

    const build = harness(root);
    build.configure("build");
    await expect(build.start()).rejects.toThrow("problem");
  });

  it("regenerates after a burst of changes under domain/ and read/, ignoring the rest", async () => {
    const root = await project();
    const { configure, start, serve, recorded, clock, close } = harness(root, { debounceMs: 20 });
    configure("serve");
    await start();
    const watcher = serve();

    await writeFile(
      join(root, "app/domain/order/order-shipped.ts"),
      'import type { Event } from "./+types/order-shipped";\n\nexport const apply = ({ state }: Event.ApplyArgs) => state;\n',
    );
    watcher.emit("add", join(root, "app/domain/order/order-shipped.ts"));
    watcher.emit("change", join(root, "app/domain/order/order-shipped.ts"));
    expect(clock.pending()).toBe(1);
    clock.advance(20);
    await until(() => exists(join(root, "app/domain/order/+types/order-shipped.ts")));
    await until(async () =>
      (await readFile(join(root, ".bounda/registry.ts"), "utf8")).includes("order-shipped"),
    );

    watcher.emit("change", join(root, "app/domain/order/+types/order-shipped.ts"));
    watcher.emit("change", join(root, "app/routes/home.tsx"));
    watcher.emit("change", join(root, "bounda.config.ts"));
    await rm(join(root, "app/domain/order/order-shipped.ts"));
    expect(clock.pending()).toBe(0);
    expect(await exists(join(root, "app/domain/order/+types/order-shipped.ts"))).toBe(true);

    watcher.emit("unlink", join(root, "app/domain/order/order-shipped.ts"));
    clock.advance(20);
    await until(
      async () => !(await exists(join(root, "app/domain/order/+types/order-shipped.ts"))),
    );
    expect(recorded.errors).toEqual([]);
    await close();
  });

  it("ignores changes outside domain/ and read/, and events before the config is resolved", async () => {
    const root = await project();
    const early = harness(root, { debounceMs: 20 });
    const earlyWatcher = early.serve();
    expect(() =>
      earlyWatcher.emit("change", join(root, "app/domain/order/order-paid.ts")),
    ).not.toThrow();
    expect(early.clock.pending()).toBe(0);
    expect(await exists(join(root, ".bounda/registry.ts"))).toBe(false);

    const { configure, start, serve, clock, close } = harness(root, { debounceMs: 20 });
    configure("serve");
    await start();
    const watcher = serve();
    await rm(join(root, ".bounda/registry.ts"));
    for (const file of [
      "app/routes/home.tsx",
      "app/root.tsx",
      "bounda.config.ts",
      "app/domain/order/+types/order-paid.ts",
      "application/domain/order/order-paid.ts",
    ]) {
      watcher.emit("change", join(root, file));
    }
    expect(clock.pending()).toBe(0);
    expect(await exists(join(root, ".bounda/registry.ts"))).toBe(false);

    await mkdir(join(root, "app/read/summary"), { recursive: true });
    await writeFile(join(root, "app/read/summary/view.ts"), "export const fields = () => ({});\n");
    watcher.emit("addDir", join(root, "app/read/summary"));
    expect(clock.pending()).toBe(1);
    clock.advance(20);
    await until(() => exists(join(root, "app/read/summary/+types/view.ts")));
    expect(await exists(join(root, ".bounda/registry.ts"))).toBe(true);
    await close();
  });

  it("reports a generator failure that is not about conventions and keeps watching", async () => {
    const root = await project();
    const { configure, start, serve, recorded, clock, close } = harness(root, { debounceMs: 20 });
    configure("serve");
    await start();
    const watcher = serve();

    await rm(join(root, ".bounda"), { recursive: true });
    await writeFile(join(root, ".bounda"), "not a directory\n");
    watcher.emit("change", join(root, "app/domain/order/order-paid.ts"));
    clock.advance(20);
    await until(async () => recorded.errors.length > 0);
    expect(recorded.errors[0]).toMatch(/^\[bounda\] .*(ENOTDIR|EEXIST|not a directory)/i);

    await rm(join(root, ".bounda"));
    watcher.emit("change", join(root, "app/domain/order/order-paid.ts"));
    clock.advance(20);
    await until(() => exists(join(root, ".bounda/registry.ts")));
    await close();
  });

  it("keeps serving after a change that breaks a convention, and recovers", async () => {
    const root = await project();
    const { configure, start, serve, recorded, clock, close } = harness(root, { debounceMs: 20 });
    configure("serve");
    await start();
    const watcher = serve();

    await writeFile(join(root, "app/domain/order/Loose.ts"), "export {};\n");
    watcher.emit("add", join(root, "app/domain/order/Loose.ts"));
    clock.advance(20);
    await until(async () => recorded.errors.join("\n").includes("Loose.ts"));
    expect(recorded.errors[0]).toMatch(/^\[bounda\] error: 1 problem in the project layout\n/);

    await rm(join(root, "app/domain/order/Loose.ts"));
    await rm(join(root, ".bounda/registry.ts"));
    watcher.emit("unlink", join(root, "app/domain/order/Loose.ts"));
    clock.advance(20);
    await until(() => exists(join(root, ".bounda/registry.ts")));
    await close();
  });

  it("drops a regeneration still waiting when the server closes", async () => {
    const root = await project();
    const { configure, start, serve, clock, close } = harness(root, { debounceMs: 20 });
    configure("serve");
    await start();
    const watcher = serve();
    await writeFile(
      join(root, "app/domain/order/order-shipped.ts"),
      "export const apply = () => ({});\n",
    );
    watcher.emit("add", join(root, "app/domain/order/order-shipped.ts"));
    expect(clock.pending()).toBe(1);
    await close();
    expect(clock.pending()).toBe(0);
    clock.advance(20);
    await close();
    expect(await exists(join(root, "app/domain/order/+types/order-shipped.ts"))).toBe(false);
  });

  it("waits for the regeneration in flight when the server closes", async () => {
    const root = await project();
    const { configure, start, serve, clock, close } = harness(root, { debounceMs: 20 });
    configure("serve");
    await start();
    const watcher = serve();
    await writeFile(
      join(root, "app/domain/order/order-shipped.ts"),
      "export const apply = () => ({});\n",
    );
    watcher.emit("add", join(root, "app/domain/order/order-shipped.ts"));
    clock.advance(20);
    await close();
    expect(await exists(join(root, "app/domain/order/+types/order-shipped.ts"))).toBe(true);
    expect(
      (await readFile(join(root, ".bounda/registry.ts"), "utf8")).includes("order-shipped"),
    ).toBe(true);
  });

  it("is the same plugin behind the public bounda(), with its options, on the wall clock", async () => {
    const root = await project();
    const plugin = bounda({ consistency: "eventual" });
    const recorded = recordingLogger();
    expect(plugin.name).toBe("bounda");
    expect(plugin.enforce).toBe("pre");
    const configResolved = hookOf(plugin, "configResolved") as (
      this: unknown,
      config: ResolvedConfig,
    ) => void;
    configResolved.call({}, { root, command: "serve", logger: recorded.logger } as ResolvedConfig);
    const load = hookOf(plugin, "load") as (this: unknown, id: string) => unknown;
    const resolveId = hookOf(plugin, "resolveId") as (this: unknown, id: string) => unknown;
    const server = load.call(
      { environment: { config: { consumer: "server" } } },
      resolveId.call({}, "@bounda-dev/react-router/app") as string,
    );
    expect(server).toContain('consistency: "eventual"');

    const watcher = new EventEmitter();
    const configureServer = hookOf(plugin, "configureServer") as (
      this: unknown,
      server: ViteDevServer,
    ) => void;
    configureServer.call({}, { watcher } as unknown as ViteDevServer);
    expect(() =>
      watcher.emit("change", join(root, "app/domain/order/order-paid.ts")),
    ).not.toThrow();
    const closeBundle = hookOf(plugin, "closeBundle") as (this: unknown) => Promise<void>;
    await closeBundle.call({});
    expect(recorded.errors).toEqual([]);
  });
});
