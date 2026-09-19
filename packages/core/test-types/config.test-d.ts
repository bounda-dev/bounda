import type { AdapterDefinition } from "@bounda-dev/core/adapter";
import { defineConfig } from "@bounda-dev/core/config";
import { describe, expectTypeOf, it } from "vitest";

declare const sqlite: AdapterDefinition<"sqlite", { path: string }>;

describe("defineConfig", () => {
  it("keeps the literal type of what it is given", () => {
    const config = defineConfig({ storage: sqlite, runtime: { role: "worker" } });
    expectTypeOf(config.runtime.role).toEqualTypeOf<"worker">();
    expectTypeOf(config.storage).toEqualTypeOf<AdapterDefinition<"sqlite", { path: string }>>();
  });

  it("checks duration strings at compile time", () => {
    defineConfig({
      storage: sqlite,
      runtime: { policies: { timeout: "30s" }, processes: { timeout: "7d" } },
    });
    defineConfig({ storage: sqlite, runtime: { dispatcher: { pollInterval: 250 } } });
    // @ts-expect-error "7 days" is not a duration string
    defineConfig({ storage: sqlite, runtime: { policies: { timeout: "7 days" } } });
    // @ts-expect-error "48x" uses an unknown unit
    defineConfig({ storage: sqlite, runtime: { processes: { timeout: "48x" } } });
  });

  it("rejects unknown keys and wrong roles", () => {
    // @ts-expect-error storag is not a config key
    defineConfig({ storag: sqlite });
    // @ts-expect-error batch is not a role
    defineConfig({ storage: sqlite, runtime: { role: "batch" } });
  });

  it("requires storage to be an adapter definition", () => {
    // @ts-expect-error a plain object is not an adapter definition
    defineConfig({ storage: { path: "./x.db" } });
  });
});
