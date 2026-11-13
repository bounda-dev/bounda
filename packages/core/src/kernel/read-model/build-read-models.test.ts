import { describe, expect, it } from "vitest";
import type { Adapter, CreateReadModelArgs } from "../../adapter/adapter.ts";
import { resolveConfig } from "../../config/schema.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { ReadModelEntry, Registry } from "../../modules/registry.ts";
import { type FieldsArgs, type FieldsRecord, fieldBuilder as f } from "../../modules/view.ts";
import { buildReadModels, personalDataOf } from "./build-read-models.ts";

const view = { fields: ({ f }: FieldsArgs) => ({ orderId: f.string().primaryKey() }) };

const registry: Registry = {
  aggregates: {},
  readModels: {
    orderSummary: {
      view,
      projections: {
        order: {
          orderPlaced: { project: () => undefined },
          paid: { on: "OrderPaid", project: () => undefined },
          anyChange: { on: ["OrderPlaced", "OrderArchived"], project: () => undefined },
        },
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
        const model = await base.createReadModel<Row>(args);
        return {
          ...model,
          close: async () => {
            closes += 1;
            await model.close();
          },
        };
      },
    },
    closes: () => closes,
  };
};

describe("buildReadModels", () => {
  it("indexes projections by the qualified events they declare, defaulting to the capitalized key", async () => {
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
      "order.OrderPlaced": ["order.orderPlaced", "order.anyChange"],
      "order.OrderPaid": ["order.paid"],
      "order.OrderArchived": ["order.anyChange"],
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

describe("personalDataOf", () => {
  const forgetting: ReadModelEntry = {
    view,
    projections: { bounda: { personalDataForgotten: { project: () => undefined } } },
    queries: {},
  };
  const of = (fields: FieldsRecord, entry: ReadModelEntry = forgetting) =>
    personalDataOf({ name: "customers", entry, fields });

  it("names the person field, the personal ones and the primary key", () => {
    expect(
      of({
        orderId: f.string().primaryKey(),
        customerId: f.string().person(),
        email: f.string().personal(),
        total: f.number(),
        address: f.json<{ street: string }>().personal().optional(),
      }),
    ).toEqual({ person: "customerId", personal: ["email", "address"], primaryKey: "orderId" });
    expect(
      of({ customerId: f.string().primaryKey().person() }, { ...forgetting, projections: {} }),
    ).toEqual({ person: "customerId", personal: [], primaryKey: "customerId" });
  });

  it("is null for a read model without a person field", () => {
    expect(of({ orderId: f.string().primaryKey(), total: f.number() })).toBeNull();
  });

  it("refuses more than one person field, personal fields without one, and fields in the clear that are never forgotten", () => {
    expect(() => of({ id: f.string().primaryKey().person(), other: f.string().person() })).toThrow(
      new ConfigurationError(
        'Read model "customers" marks more than one field with .person(): id, other',
      ),
    );
    expect(() => of({ id: f.string().primaryKey(), email: f.string().personal() })).toThrow(
      new ConfigurationError(
        'Read model "customers" has fields marked .personal() and none marked .person(), the id of the person they belong to',
      ),
    );
    const unforgotten = new ConfigurationError(
      'Read model "customers" keeps fields marked .personal({ clear: true }) (email), so it needs projections/bounda/personal-data-forgotten.ts',
    );
    const clear = {
      id: f.string().primaryKey().person(),
      email: f.string().personal({ clear: true }),
      note: f.string().personal(),
    };
    expect(() => of(clear, { view, projections: {}, queries: {} })).toThrow(unforgotten);
    expect(() => of(clear, { view, projections: { bounda: {} }, queries: {} })).toThrow(
      unforgotten,
    );
  });

  it("needs no projection of PersonalDataForgotten for personal fields that are all sealed", () => {
    expect(
      of(
        { id: f.string().primaryKey().person(), email: f.string().personal() },
        { view, projections: {}, queries: {} },
      ),
    ).toEqual({ person: "id", personal: ["email"], primaryKey: "id" });
  });

  it("fails the start before opening the read model's storage", async () => {
    const { adapter, closes } = countingAdapter();
    let opened = 0;
    const counted: Adapter = {
      ...adapter,
      createReadModel: <Row extends object>(args: CreateReadModelArgs) => {
        opened += 1;
        return adapter.createReadModel<Row>(args);
      },
    };
    await expect(
      buildReadModels({
        registry: {
          aggregates: {},
          readModels: {
            customers: {
              view: {
                fields: ({ f: field }: FieldsArgs) => ({
                  id: field.string().primaryKey(),
                  email: field.string().personal(),
                }),
              },
              projections: {},
              queries: {},
            },
          },
        },
        config: resolveConfig({ storage: counted }),
        logger: silentLogger,
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(opened).toBe(0);
    expect(closes()).toBe(0);
  });
});
