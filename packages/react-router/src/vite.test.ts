import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger, Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { bounda } from "./vite.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixtureRoot = join(repoRoot, "packages/core/test-types/fixtures/order-app-inferred");
const temporary: string[] = [];

afterAll(async () => {
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })));
});

const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-vite-"));
  temporary.push(root);
  await cp(join(fixtureRoot, "app"), join(root, "app"), {
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
}

const harness = (root: string, options?: Parameters<typeof bounda>[0]): Harness => {
  const plugin = bounda(options);
  const recorded = recordingLogger();
  return {
    plugin,
    recorded,
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

describe("bounda() Vite plugin", () => {
  it("resolves the app module and nothing else, before Vite's own resolver", () => {
    const { plugin, resolve: resolveId } = harness("/project");
    expect(plugin.enforce).toBe("pre");
    expect(resolveId("@bounda-dev/react-router/app")).toBe("\0@bounda-dev/react-router/app");
    expect(resolveId("@bounda-dev/react-router")).toBeNull();
    expect(resolveId("./app.ts")).toBeNull();
  });

  it("serves the server module wired to the project's registry, reading its own writes", () => {
    const { configure, load } = harness("/project");
    configure("serve");
    const code = load("\0@bounda-dev/react-router/app", "server");
    expect(code).toContain('import { registry } from "/project/.bounda/registry.ts";');
    expect(code).toContain('boot: () => boot({ root: "/project", registry })');
    expect(code).toContain('consistency: "immediate"');
    expect(code).toContain("export const { bounda, boundaMiddleware, dispose } = createBounda(");
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
    expect(code).not.toContain("registry");
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
    const { configure, start, serve, recorded } = harness(root, { debounceMs: 20 });
    configure("serve");
    await start();
    const watcher = serve();

    await writeFile(
      join(root, "app/domain/order/order-shipped.ts"),
      'import type { Event } from "./+types/order-shipped";\n\nexport const apply = ({ state }: Event.ApplyArgs) => state;\n',
    );
    watcher.emit("add", join(root, "app/domain/order/order-shipped.ts"));
    watcher.emit("change", join(root, "app/domain/order/order-shipped.ts"));
    await settle(400);
    expect(await exists(join(root, "app/domain/order/+types/order-shipped.ts"))).toBe(true);
    expect(await readFile(join(root, ".bounda/registry.ts"), "utf8")).toContain("order-shipped");

    watcher.emit("change", join(root, "app/domain/order/+types/order-shipped.ts"));
    watcher.emit("change", join(root, "app/routes/home.tsx"));
    watcher.emit("change", join(root, "bounda.config.ts"));
    await rm(join(root, "app/domain/order/order-shipped.ts"));
    await settle(400);
    expect(await exists(join(root, "app/domain/order/+types/order-shipped.ts"))).toBe(true);

    watcher.emit("unlink", join(root, "app/domain/order/order-shipped.ts"));
    await settle(400);
    expect(await exists(join(root, "app/domain/order/+types/order-shipped.ts"))).toBe(false);
    expect(recorded.errors).toEqual([]);
  });

  it("ignores changes outside domain/ and read/, and events before the config is resolved", async () => {
    const root = await project();
    const early = harness(root, { debounceMs: 20 });
    const earlyWatcher = early.serve();
    expect(() =>
      earlyWatcher.emit("change", join(root, "app/domain/order/order-paid.ts")),
    ).not.toThrow();
    await settle(200);
    expect(await exists(join(root, ".bounda/registry.ts"))).toBe(false);

    const { configure, start, serve } = harness(root, { debounceMs: 20 });
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
    await settle(300);
    expect(await exists(join(root, ".bounda/registry.ts"))).toBe(false);

    await mkdir(join(root, "app/read/summary"), { recursive: true });
    await writeFile(join(root, "app/read/summary/view.ts"), "export const fields = () => ({});\n");
    watcher.emit("addDir", join(root, "app/read/summary"));
    await settle(300);
    expect(await exists(join(root, ".bounda/registry.ts"))).toBe(true);
    expect(await exists(join(root, "app/read/summary/+types/view.ts"))).toBe(true);
  });

  it("keeps serving after a change that breaks a convention, and recovers", async () => {
    const root = await project();
    const { configure, start, serve, recorded } = harness(root, { debounceMs: 20 });
    configure("serve");
    await start();
    const watcher = serve();

    await writeFile(join(root, "app/domain/order/Loose.ts"), "export {};\n");
    watcher.emit("add", join(root, "app/domain/order/Loose.ts"));
    await settle(400);
    expect(recorded.errors.join("\n")).toContain("Loose.ts");

    await rm(join(root, "app/domain/order/Loose.ts"));
    watcher.emit("unlink", join(root, "app/domain/order/Loose.ts"));
    await settle(400);
    expect(await exists(join(root, ".bounda/registry.ts"))).toBe(true);
  });
});
