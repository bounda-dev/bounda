import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../contracts/errors.ts";
import { memory } from "../memory/index.ts";
import type { Registry } from "../modules/registry.ts";
import { checkConfigNames } from "./names.ts";
import { resolveConfig } from "./schema.ts";

const aggregate = { events: {}, commands: {}, policies: {}, processes: {} };
const readModel = { view: { fields: () => ({}) }, projections: {}, queries: {} };

const registry = {
  aggregates: { order: aggregate, customer: aggregate },
  readModels: { orders: readModel, customers: readModel },
} satisfies Registry;

describe("checkConfigNames", () => {
  it("accepts the read models and aggregates the registry has", () => {
    const config = resolveConfig({
      storage: memory(),
      readModels: { orders: memory() },
      runtime: { overrides: { customer: { commands: { timeout: "1s" } } } },
    });
    expect(() => checkConfigNames({ registry, config })).not.toThrow();
  });

  it("names every key the registry lacks, and the ones it has", () => {
    const config = resolveConfig({
      storage: memory(),
      readModels: { ordrs: memory(), orders: memory() },
      runtime: { overrides: { ordr: { commands: { timeout: "1s" } } } },
    });
    expect(() => checkConfigNames({ registry, config })).toThrow(
      new ConfigurationError(
        [
          "Invalid configuration:",
          '  readModels.ordrs: there is no read model "ordrs"; the registry has: orders, customers',
          '  runtime.overrides.ordr: there is no aggregate "ordr"; the registry has: order, customer',
        ].join("\n"),
      ),
    );
  });

  it("says the registry has none when it is empty", () => {
    const config = resolveConfig({ storage: memory(), readModels: { orders: memory() } });
    expect(() =>
      checkConfigNames({ registry: { aggregates: {}, readModels: {} }, config }),
    ).toThrow('readModels.orders: there is no read model "orders"; the registry has: none');
  });
});
