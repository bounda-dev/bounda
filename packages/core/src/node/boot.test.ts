import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigurationError } from "../contracts/errors.ts";
import { createSequentialIdGenerator } from "../contracts/ids.ts";
import { silentLogger } from "../contracts/logger.ts";
import { createRecordingLogger } from "../kernel/test-support.ts";
import { memory } from "../memory/index.ts";
import { boot, loadProject } from "./boot.ts";
import { registry } from "./fixtures/project/registry.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "project");
const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "project-default");

afterEach(() => {
  delete process.env.BOUNDA_ROLE;
  delete process.env.BOUNDA_TEST_MARKER;
});

describe("loadProject", () => {
  it("imports the configuration and the registry without creating an app", async () => {
    const project = await loadProject<typeof registry>({
      root,
      registryPath: "registry.ts",
      logger: silentLogger,
    });
    expect(process.env.BOUNDA_TEST_MARKER).toBe("loaded");
    expect(project.registry).toBe(registry);
    expect(project.config.runtime?.role).toBe("worker");
  });

  it("takes what it is given instead of importing it", async () => {
    const config = { storage: memory() };
    const project = await loadProject({ root, env: false, registry, config, logger: silentLogger });
    expect(process.env.BOUNDA_TEST_MARKER).toBeUndefined();
    expect(project).toEqual({ config, registry });
  });
});

describe("boot", () => {
  it("loads .env, imports the configuration and the registry from the project root", async () => {
    const app = await boot<typeof registry>({
      root,
      registryPath: "registry.ts",
      signals: false,
      logger: silentLogger,
    });
    expect(process.env.BOUNDA_TEST_MARKER).toBe("loaded");
    expect(app.role).toBe("worker");
    await app.commands.increment({ counterId: "c-1" });
    await app.processUntilIdle();
    expect((await app.getLag()).lastPosition).toBe(1);
    await app.stop();
  });

  it("never overwrites variables that are already set", async () => {
    process.env.BOUNDA_TEST_MARKER = "preset";
    const app = await boot({
      root,
      signals: false,
      logger: silentLogger,
      registry,
      config: { storage: memory() },
    });
    expect(process.env.BOUNDA_TEST_MARKER).toBe("preset");
    await app.stop();
  });

  it("accepts the configuration and the registry directly and can skip .env", async () => {
    const app = await boot({
      root,
      env: false,
      signals: false,
      logger: silentLogger,
      registry,
      config: { storage: memory(), runtime: { role: "all" } },
    });
    expect(process.env.BOUNDA_TEST_MARKER).toBeUndefined();
    expect(app.role).toBe("all");
    await app.stop();
  });

  it("explains a missing configuration or registry file", async () => {
    await expect(
      boot({ root, registryPath: "missing.ts", signals: false, logger: silentLogger }),
    ).rejects.toThrow(/Cannot find the registry \(export "registry"\) at .*missing\.ts/);
    await expect(
      boot({ root: join(root, "nowhere"), signals: false, logger: silentLogger }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("explains a module without the expected export", async () => {
    await expect(
      boot({ root, registryPath: "bounda.config.ts", signals: false, logger: silentLogger }),
    ).rejects.toThrow(/does not export the registry/);
  });

  it("removes its signal listeners once the app is stopped", async () => {
    const before = process.listenerCount("SIGTERM");
    const app = await boot<typeof registry>({
      root,
      registryPath: "registry.ts",
      logger: silentLogger,
    });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
    await app.stop();
    expect(process.listenerCount("SIGTERM")).toBe(before);
    await app.stop();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("reads .bounda/registry.ts by default and reports the environment it loaded", async () => {
    const recording = createRecordingLogger();
    const app = await boot<typeof registry>({
      root: defaultRoot,
      signals: false,
      logger: recording.logger,
    });
    expect(await app.commands.increment({ counterId: "c-1" })).toMatchObject({ version: 1 });
    expect(recording.entries.filter((entry) => entry.message === "environment loaded")).toEqual([]);
    await app.stop();

    const withEnv = createRecordingLogger();
    const other = await boot<typeof registry>({
      root,
      registryPath: "registry.ts",
      signals: false,
      logger: withEnv.logger,
    });
    expect(withEnv.entries).toContainEqual({
      level: "debug",
      message: "environment loaded",
      fields: { path: join(root, ".env") },
    });
    await other.stop();
  });

  it("fails on an .env it cannot read instead of ignoring it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bounda-boot-"));
    try {
      await mkdir(join(directory, ".env"));
      await expect(
        boot({
          root: directory,
          config: { storage: memory() },
          registry,
          signals: false,
          logger: silentLogger,
        }),
      ).rejects.toThrow(/\.env/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("names the configuration it could not find", async () => {
    await expect(
      boot({ root: join(root, "nowhere"), signals: false, logger: silentLogger }),
    ).rejects.toThrow(/Cannot find the configuration \(default export\) at .*bounda\.config\.ts/);
  });

  it("passes the id generator through to the app", async () => {
    const app = await boot<typeof registry>({
      root,
      config: { storage: memory() },
      registry,
      ids: createSequentialIdGenerator({ prefix: "fixed" }),
      signals: false,
      logger: silentLogger,
    });
    const result = await app.commands.increment({ counterId: "c-1" });
    expect(result).toMatchObject({ scheduled: false });
    expect((result as { eventIds: readonly string[] }).eventIds[0]).toMatch(/^fixed-\d+$/);
    await app.stop();
  });

  it("leaves the process signals alone when told to", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const app = await boot<typeof registry>({
      root,
      registryPath: "registry.ts",
      signals: false,
      logger: silentLogger,
    });
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    await app.stop();
  });

  it("stops the app on SIGTERM", async () => {
    const recording = createRecordingLogger();
    const sigint = process.listenerCount("SIGINT");
    const app = await boot<typeof registry>({
      root,
      registryPath: "registry.ts",
      logger: recording.logger,
    });
    expect(process.listenerCount("SIGINT")).toBe(sigint + 1);
    app.start();
    process.emit("SIGTERM", "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recording.entries).toContainEqual({
      level: "info",
      message: "stopping",
      fields: { signal: "SIGTERM" },
    });
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    await expect(app.commands.increment({ counterId: "c-after-sigterm" })).resolves.toMatchObject({
      version: 1,
    });
    await app.stop();
  });
});
