import { describe, expect, it } from "vitest";
import type { AdapterDefinition } from "../adapter/adapter-definition.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import { resolveConfig } from "./schema.ts";

const sqlite: AdapterDefinition<"sqlite", { path: string }> = {
  kind: "bounda-adapter",
  name: "sqlite",
  options: { path: "./data.db" },
};

const postgres: AdapterDefinition<"postgresql", { url: string }> = {
  kind: "bounda-adapter",
  name: "postgresql",
  options: { url: "postgres://localhost/app" },
};

const message = (config: unknown): string => {
  try {
    resolveConfig(config as never);
  } catch (error) {
    if (error instanceof ConfigurationError) return error.message;
    throw error;
  }
  throw new Error("expected resolveConfig to throw");
};

describe("resolveConfig", () => {
  it("fills every default from a minimal config", () => {
    const resolved = resolveConfig({ storage: sqlite });
    expect(resolved.rootDir).toBe("app");
    expect(resolved.storage).toBe(sqlite);
    expect(resolved.readModels).toEqual({});
    expect(resolved.commands).toEqual({});
    expect(resolved.runtime).toEqual({
      role: "all",
      commands: { concurrencyRetries: 3 },
      policies: {
        retry: { strategy: "exponential", maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
        timeoutMs: 30_000,
        maxChainDepth: 25,
      },
      processes: {
        retry: { strategy: "exponential", maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
        timeoutMs: 604_800_000,
      },
      dispatcher: { pollIntervalMs: 100, batchSize: 100 },
      overrides: {},
    });
  });

  it("converts durations to milliseconds and keeps explicit values", () => {
    const resolved = resolveConfig({
      storage: postgres,
      readModels: { "users-directory": sqlite },
      runtime: {
        role: "worker",
        commands: { concurrencyRetries: 0 },
        policies: { retry: { strategy: "fixed", maxAttempts: 5, baseDelay: "2s" }, timeout: "1m" },
        processes: { timeout: "48h" },
        dispatcher: { pollInterval: 250, batchSize: 10 },
      },
      commands: { placeOrder: { inventory: { use: "http" } } },
    });
    expect(resolved.runtime.role).toBe("worker");
    expect(resolved.runtime.commands.concurrencyRetries).toBe(0);
    expect(resolved.runtime.policies.retry).toEqual({
      strategy: "fixed",
      maxAttempts: 5,
      baseDelayMs: 2_000,
      maxDelayMs: 30_000,
    });
    expect(resolved.runtime.policies.timeoutMs).toBe(60_000);
    expect(resolved.runtime.processes.timeoutMs).toBe(172_800_000);
    expect(resolved.runtime.dispatcher).toEqual({ pollIntervalMs: 250, batchSize: 10 });
    expect(resolved.readModels["users-directory"]).toBe(sqlite);
    expect(resolved.commands.placeOrder?.inventory?.use).toBe("http");
  });

  it("resolves per-aggregate overrides on top of the global values", () => {
    const resolved = resolveConfig({
      storage: sqlite,
      runtime: {
        policies: { maxChainDepth: 10, timeout: "20s" },
        overrides: { order: { policies: { maxChainDepth: 3 } } },
      },
    });
    expect(resolved.forAggregate("order")).toEqual({
      policies: {
        retry: { strategy: "exponential", maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
        timeoutMs: 20_000,
        maxChainDepth: 3,
      },
      processes: resolved.runtime.processes,
    });
    expect(resolved.forAggregate("customer")).toEqual({
      policies: resolved.runtime.policies,
      processes: resolved.runtime.processes,
    });
    expect(resolved.forAggregate("customer").policies.maxChainDepth).toBe(10);
  });

  it("rejects a storage that is not an adapter definition", () => {
    expect(message({ storage: { path: "./x.db" } })).toContain(
      "storage: Expected an adapter definition such as sqlite({ ... })",
    );
    expect(message({})).toContain("storage:");
  });

  it("rejects malformed durations with their path", () => {
    expect(message({ storage: sqlite, runtime: { policies: { timeout: "7 days" } } })).toContain(
      'runtime.policies.timeout: Invalid duration: "7 days"',
    );
  });

  it("rejects unknown keys anywhere", () => {
    expect(message({ storage: sqlite, storag: sqlite })).toMatch(/Unrecognized key/);
    expect(message({ storage: sqlite, runtime: { rol: "web" } })).toMatch(/runtime: .*rol/);
  });

  it("rejects out-of-range numbers and empty implementation names", () => {
    expect(message({ storage: sqlite, runtime: { policies: { maxChainDepth: 0 } } })).toContain(
      "runtime.policies.maxChainDepth",
    );
    expect(
      message({ storage: sqlite, commands: { placeOrder: { inventory: { use: "" } } } }),
    ).toContain("commands.placeOrder.inventory.use");
  });

  it("lists every problem in one error", () => {
    const text = message({
      storage: sqlite,
      runtime: { role: "batch", dispatcher: { batchSize: 0 } },
    });
    expect(text).toContain("runtime.role");
    expect(text).toContain("runtime.dispatcher.batchSize");
  });
});
