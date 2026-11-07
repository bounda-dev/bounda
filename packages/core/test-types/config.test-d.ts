import type { AdapterDefinition } from "@bounda-dev/core/adapter";
import {
  type Config,
  defineConfig,
  defineKeyWrapper,
  type KeyWrapper,
  type KeyWrapperDefinition,
  masterKey,
} from "@bounda-dev/core/config";
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

  it("checks a read model's ports in the same section", () => {
    defineConfig({ storage: sqlite, ports: { ...ports, orderSummary: { rates: "fixed" } } });
    // @ts-expect-error "ecb" is not an implementation of rates
    defineConfig({ storage: sqlite, ports: { ...ports, orderSummary: { rates: "ecb" } } });
  });

  it("checks duration strings at compile time", () => {
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        commands: { timeout: "10s" },
        policies: { timeout: "30s" },
        processes: { timeout: "7d", handlerTimeout: "1m" },
        overrides: {
          order: { commands: { timeout: 5_000 }, processes: { handlerTimeout: 90_000 } },
        },
      },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { commands: { idempotencyKeyLifetime: "48h" } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        commands: {
          // @ts-expect-error "two days" is not a duration string
          idempotencyKeyLifetime: "two days",
        },
      },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        overrides: {
          order: { snapshot: { every: 200 } },
          customer: { snapshot: { every: 50, verify: 0.1, version: 2 } },
        },
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
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        processes: {
          // @ts-expect-error "a minute" is not a duration string
          handlerTimeout: "a minute",
        },
      },
    });
  });

  it("rejects unknown keys and wrong roles", () => {
    // @ts-expect-error storag is not a config key
    defineConfig({ storag: sqlite, ports });
    expectTypeOf<Config>().not.toHaveProperty("rootDir");
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error concurrencyRetries is not overridden per aggregate
      runtime: { overrides: { order: { commands: { concurrencyRetries: 1 } } } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error idempotencyKeyLifetime is not overridden per aggregate
      runtime: { overrides: { order: { commands: { idempotencyKeyLifetime: "1h" } } } },
    });
    defineConfig({ storage: sqlite, ports, runtime: { personalData: { retention: "30d" } } });
    defineConfig({ storage: sqlite, ports, runtime: { personalData: { retention: 86_400_000 } } });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error "a month" is not a duration string
      runtime: { personalData: { retention: "a month" } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error the retention is app-wide, never per aggregate
      runtime: { overrides: { order: { personalData: { retention: "30d" } } } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        personalData: {
          retention: "30d",
          keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY", previous: ["BOUNDA_MASTER_KEY_OLD"] }),
        },
      },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error the master key is named by its variable, never given as a value
      runtime: { personalData: { keyWrapper: "BOUNDA_MASTER_KEY" } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error a wrapper is given through defineKeyWrapper, not as it is
      runtime: { personalData: { keyWrapper: {} as KeyWrapper } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error the key wrapper is app-wide, never per aggregate
      runtime: { overrides: { order: { personalData: { keyWrapper: masterKey({ from: "K" }) } } } },
    });
    // @ts-expect-error batch is not a role
    defineConfig({ storage: sqlite, ports, runtime: { role: "batch" } });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error every is a number of events
      runtime: { overrides: { order: { snapshot: { every: "200" } } } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error snapshots are opted into per aggregate, not app-wide
      runtime: { snapshot: { every: 200 } },
    });
  });

  it("requires storage to be an adapter definition", () => {
    // @ts-expect-error a plain object is not an adapter definition
    defineConfig({ storage: { path: "./x.db" }, ports });
  });

  it("types the key wrappers: masterKey names variables, defineKeyWrapper builds one from env", () => {
    expectTypeOf(masterKey).parameter(0).toEqualTypeOf<{
      readonly from: string;
      readonly previous?: readonly string[];
    }>();
    expectTypeOf(masterKey({ from: "BOUNDA_MASTER_KEY" })).toEqualTypeOf<KeyWrapperDefinition>();
    const kms = defineKeyWrapper(({ env: received }) => {
      expectTypeOf(received).toEqualTypeOf(env);
      return {
        kid: "arn:aws:kms:eu-west-1:1:key/1",
        wrap: async (key) => {
          expectTypeOf(key).toEqualTypeOf<Uint8Array>();
          return key;
        },
        unwrap: async ({ kid, wrapped }) => {
          expectTypeOf(kid).toEqualTypeOf<string>();
          return wrapped;
        },
      };
    });
    expectTypeOf(kms).toEqualTypeOf<KeyWrapperDefinition>();
    expectTypeOf<KeyWrapper["previous"]>().toEqualTypeOf<readonly string[] | undefined>();
    // @ts-expect-error a wrapper names the key it wraps under
    defineKeyWrapper(() => ({
      wrap: async (key: Uint8Array) => key,
      unwrap: async () => new Uint8Array(),
    }));
    defineConfig({ storage: sqlite, ports, runtime: { personalData: { keyWrapper: kms } } });
  });
});
