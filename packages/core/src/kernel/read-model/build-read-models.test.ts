import { describe, expect, it } from "vitest";
import type { Adapter, CreateReadModelArgs } from "../../adapter/adapter.ts";
import { resolveConfig } from "../../config/schema.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { buildReadModels } from "./build-read-models.ts";

const view = { fields: ({ f }: FieldsArgs) => ({ orderId: f.string().primaryKey() }) };

const registry: Registry = {
  aggregates: {},
  readModels: {
    orderSummary: {
      view,
      projections: {
        orderPlaced: { project: () => undefined },
        paid: { on: "OrderPaid", project: () => undefined },
        anyChange: { on: ["OrderPlaced", "OrderArchived"], project: () => undefined },
      },
      queries: {},
    },
    customerOrders: { view, projections: {}, queries: {} },
  },
};

const countingAdapter = (): { readonly adapter: Adapter; readonly closes: () => number } => {
  const base = memory();
  let closes = 0;
  return {
    adapter: {
      ...base,
      createReadModel: async <Row extends object>(args: CreateReadModelArgs) => {
        const ports = await base.createReadModel<Row>(args);
        return {
          ...ports,
          close: async () => {
            closes += 1;
            await ports.close();
          },
        };
      },
    },
    closes: () => closes,
  };
};

describe("buildReadModels", () => {
  it("indexes projections by the events they declare, defaulting to the capitalized key", async () => {
    const readModels = await buildReadModels({
      registry,
      config: resolveConfig({ storage: memory() }),
      logger: silentLogger,
    });
    const byEvent = readModels.byName.orderSummary?.projectionsByEvent ?? {};
    expect(
      Object.fromEntries(
        Object.entries(byEvent).map(([type, list]) => [type, list.map((p) => p.key)]),
      ),
    ).toEqual({
      OrderPlaced: ["orderPlaced", "anyChange"],
      OrderPaid: ["paid"],
      OrderArchived: ["anyChange"],
    });
    expect(readModels.byName.customerOrders?.projectionsByEvent).toEqual({});
    await readModels.close();
  });

  it("requires a real adapter for a read model configured on its own", async () => {
    await expect(
      buildReadModels({
        registry,
        config: resolveConfig({
          storage: memory(),
          readModels: { orderSummary: { kind: "bounda-adapter", name: "sqlite", options: {} } },
        }),
        logger: silentLogger,
      }),
    ).rejects.toThrow(
      'Read model "orderSummary" is configured with "sqlite", which is a definition',
    );
  });

  it("closes every read model when closed", async () => {
    const { adapter, closes } = countingAdapter();
    const readModels = await buildReadModels({
      registry,
      config: resolveConfig({ storage: adapter }),
      logger: silentLogger,
    });
    expect(closes()).toBe(0);
    await readModels.close();
    expect(closes()).toBe(2);
  });
});
