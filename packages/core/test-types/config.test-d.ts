import type { AdapterDefinition } from "@bounda-dev/core/adapter";
import { defineConfig } from "@bounda-dev/core/config";
import { describe, expectTypeOf, it } from "vitest";

declare const sqlite: AdapterDefinition<"sqlite", { path: string }>;
declare const env: Readonly<Record<string, string | undefined>>;

/**
 * The fixture registers its `PortsConfig` through `register.d.ts`, and `inventory` has two
 * implementations, so every config here has to choose one.
 */
const ports = { order: { inventory: "fake" } } as const;

describe("defineConfig", () => {
  it("keeps the literal type of what it is given", () => {
    const config = defineConfig({ storage: sqlite, ports, runtime: { role: "worker" } });
    expectTypeOf(config.runtime.role).toEqualTypeOf<"worker">();
    expectTypeOf(config.storage).toEqualTypeOf<AdapterDefinition<"sqlite", { path: string }>>();
    expectTypeOf(config.ports.order.inventory).toEqualTypeOf<"fake">();
  });

  it("checks the ports section against the project's ports", () => {
    defineConfig({ storage: sqlite, ports: { order: { inventory: "memory" } } });
    defineConfig({
      storage: sqlite,
      ports: { order: { inventory: "fake", mailer: "memory", reminders: "fake" } },
    });
    const chosen = env.INVENTORY === "memory" ? "memory" : "fake";
    defineConfig({ storage: sqlite, ports: { order: { inventory: chosen } } });
  });

  it("checks duration strings at compile time", () => {
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        commands: { timeout: "10s" },
        policies: { timeout: "30s" },
        processes: { timeout: "7d" },
        overrides: { order: { commands: { timeout: 5_000 } } },
      },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { dispatcher: { pollInterval: 250 } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { dispatcher: { projectionBatchTime: "500ms" } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { dispatcher: { projectionBatchTime: 0 } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { dispatcher: { catchUp: { timeout: "5s", pollInterval: 20 } } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        dispatcher: {
          catchUp: {
            // @ts-expect-error "two seconds" is not a duration string
            timeout: "two seconds",
          },
        },
      },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { dispatcher: { backoff: { baseDelay: "250ms", maxDelay: 60_000 } } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        dispatcher: {
          backoff: {
            // @ts-expect-error "a minute" is not a duration string
            maxDelay: "a minute",
          },
        },
      },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        dispatcher: {
          // @ts-expect-error "half a second" is not a duration string
          projectionBatchTime: "half a second",
        },
      },
    });
    // @ts-expect-error "7 days" is not a duration string
    defineConfig({ storage: sqlite, ports, runtime: { policies: { timeout: "7 days" } } });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        commands: {
          // @ts-expect-error "ten seconds" is not a duration string
          timeout: "ten seconds",
        },
      },
    });
    // @ts-expect-error "48x" uses an unknown unit
    defineConfig({ storage: sqlite, ports, runtime: { processes: { timeout: "48x" } } });
  });

  it("rejects unknown keys and wrong roles", () => {
    // @ts-expect-error storag is not a config key
    defineConfig({ storag: sqlite, ports });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error concurrencyRetries is not overridden per aggregate
      runtime: { overrides: { order: { commands: { concurrencyRetries: 1 } } } },
    });
    // @ts-expect-error batch is not a role
    defineConfig({ storage: sqlite, ports, runtime: { role: "batch" } });
  });

  it("requires storage to be an adapter definition", () => {
    // @ts-expect-error a plain object is not an adapter definition
    defineConfig({ storage: { path: "./x.db" }, ports });
  });
});
