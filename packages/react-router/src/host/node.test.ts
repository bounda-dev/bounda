import { type BoundaApp, ConfigurationError, type Registry } from "@bounda-dev/core";
import type { BootArgs } from "@bounda-dev/core/node";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failure } from "../failure.ts";
import * as nodeHost from "./node.ts";
import { createHost } from "./node.ts";

const app = {
  commands: {},
  start: () => undefined,
  stop: async () => undefined,
} as unknown as BoundaApp;
const booted: BootArgs[] = [];

vi.mock("@bounda-dev/core/node", () => ({
  boot: vi.fn(async (args: BootArgs) => {
    booted.push(args);
    return app;
  }),
}));

const registry = { aggregates: {}, readModels: {} } as Registry;

const served = async (bounda: ReturnType<typeof createHost>) => {
  const context = new RouterContextProvider();
  const url = new URL("http://localhost/");
  await bounda.boundaMiddleware(
    { request: new Request(url), url, pattern: "/", params: {}, context },
    async () => undefined,
  );
  return context.get(bounda.bounda);
};

let host: ReturnType<typeof createHost> | undefined;

afterEach(async () => {
  await host?.dispose();
  booted.length = 0;
});

describe("createHost in Node", () => {
  it("boots the project from the root, registry and configuration it is given, with its consistency", async () => {
    const config = { storage: { kind: "bounda-adapter", name: "sqlite", options: {} } };
    host = createHost({
      root: "/project",
      registry,
      importConfig: async () => ({ default: config }),
      consistency: "eventual",
    });
    expect(await served(host)).toBe(app);
    expect(booted).toEqual([{ root: "/project", registry, importConfig: expect.any(Function) }]);
    expect(await booted[0]?.importConfig?.()).toEqual({ default: config });
  });

  it("leaves the root to boot without one", async () => {
    host = createHost({ registry, importConfig: async () => ({}), consistency: "eventual" });
    await served(host);
    expect(booted[0]).not.toHaveProperty("root");
    expect(await booted[0]?.importConfig?.()).toEqual({});
    expect(await booted[0]?.importConfig?.()).toEqual({});
  });

  it("explains a configuration that needs the Workers runtime, which Node cannot import", async () => {
    const unsupported = Object.assign(
      new Error(
        "Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'cloudflare:'",
      ),
      { code: "ERR_UNSUPPORTED_ESM_URL_SCHEME" },
    );
    host = createHost({
      registry,
      importConfig: async () => {
        throw unsupported;
      },
      consistency: "eventual",
    });
    await served(host);
    const refusal = await booted[0]?.importConfig?.().catch((error: unknown) => error);
    expect(refusal).toEqual(
      new ConfigurationError(
        'bounda.config.ts imports the Workers runtime, as cloudflare() does, so React Router has to run in the Worker: add cloudflare({ viteEnvironment: { name: "ssr" } }) from @cloudflare/vite-plugin to the plugins in vite.config.ts',
      ),
    );
    expect(refusal).toHaveProperty("cause", unsupported);
  });

  it("rethrows any other failure to import the configuration as it is", async () => {
    const failures: unknown[] = [
      Object.assign(new Error("Received protocol 'https:'"), {
        code: "ERR_UNSUPPORTED_ESM_URL_SCHEME",
      }),
      new Error("Received protocol 'cloudflare:'"),
      { code: "ERR_UNSUPPORTED_ESM_URL_SCHEME", message: "Received protocol 'cloudflare:'" },
    ];
    for (const failure of failures) {
      const bounda = createHost({
        registry,
        importConfig: async () => {
          throw failure;
        },
        consistency: "eventual",
      });
      await served(bounda);
      await expect(booted.at(-1)?.importConfig?.()).rejects.toBe(failure);
      await bounda.dispose();
    }
  });

  it("hands the plugin's module failure too, so that it imports nothing else", () => {
    expect(nodeHost.failure).toBe(failure);
  });

  it("reads its own writes unless told otherwise", async () => {
    host = createHost({
      registry,
      importConfig: async () => ({}),
      consistency: "read-your-writes",
    });
    expect(await served(host)).not.toBe(app);
  });
});
