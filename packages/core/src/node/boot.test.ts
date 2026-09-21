import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigurationError } from "../contracts/errors.ts";
import { silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import { boot } from "./boot.ts";
import { registry } from "./fixtures/project/registry.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "project");

afterEach(() => {
  delete process.env.BOUNDA_ROLE;
  delete process.env.BOUNDA_TEST_MARKER;
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

  it("stops the app on SIGTERM", async () => {
    const app = await boot<typeof registry>({
      root,
      registryPath: "registry.ts",
      logger: silentLogger,
    });
    app.start();
    process.emit("SIGTERM", "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(app.commands.increment({ counterId: "c-1" })).resolves.toMatchObject({
      version: 1,
    });
    await app.stop();
  });
});
