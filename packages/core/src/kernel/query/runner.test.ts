import { describe, expect, it } from "vitest";
import type { Table } from "../../adapter/ports/table.ts";
import { resolveConfig } from "../../config/schema.ts";
import { ConfigurationError, NotFoundError, ValidationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { buildReadModels } from "../read-model/build-read-models.ts";
import { buildQueries } from "./build-queries.ts";
import { createQueryRunner } from "./runner.ts";

interface Row {
  readonly orderId: string;
  readonly customerId: string;
  readonly total: number;
}

const view = {
  fields: ({ f }: FieldsArgs) => ({
    orderId: f.string().primaryKey(),
    customerId: f.string(),
    total: f.number(),
  }),
};

const registry: Registry = {
  aggregates: {},
  readModels: {
    orderSummary: {
      view,
      projections: {},
      queries: {
        getOrder: {
          payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
          repository: ({ orderId, table }: { orderId: string; table: Table<Row> }) =>
            table.findOne({ orderId }),
          handler: ({ repositoryData }: { repositoryData: Row | null }) => repositoryData,
        },
        listOrders: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          repository: ({ customerId, table }: { customerId: string; table: Table<Row> }) =>
            table.findMany({
              where: { customerId },
              orderBy: { field: "total", direction: "desc" },
            }),
          handler: ({ repositoryData }: { repositoryData: readonly Row[] }) => ({
            orders: repositoryData,
            outstanding: repositoryData.reduce((sum, row) => sum + row.total, 0),
          }),
        },
        customerOverview: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          handler: async ({
            query,
            queries,
          }: {
            query: { payload: { customerId: string } };
            queries: Record<string, (payload: unknown) => Promise<unknown>>;
          }) => {
            const list = (await queries.listOrders?.({ customerId: query.payload.customerId })) as {
              outstanding: number;
            };
            return { customerId: query.payload.customerId, outstanding: list.outstanding };
          },
        },
        countOrders: {
          handler: ({ table }: { table: Table<Row> }) => table.count(),
        },
      },
    },
  },
};

const setup = async () => {
  const config = resolveConfig({ storage: memory() });
  const readModels = await buildReadModels({ registry, config, logger: silentLogger });
  const table = readModels.byName.orderSummary?.ports.table as unknown as Table<Row>;
  await table.insert({ orderId: "o-1", customerId: "c-1", total: 10 });
  await table.insert({ orderId: "o-2", customerId: "c-1", total: 25 });
  await table.insert({ orderId: "o-3", customerId: "c-2", total: 5 });
  return createQueryRunner({ queries: buildQueries({ readModels }), readModels });
};

describe("query runner", () => {
  it("runs repository then handler with the validated payload", async () => {
    const runner = await setup();
    expect(await runner.run({ type: "GetOrder", payload: { orderId: "o-2" } })).toEqual({
      orderId: "o-2",
      customerId: "c-1",
      total: 25,
    });
    expect(await runner.facade.listOrders?.({ customerId: "c-1" })).toEqual({
      orders: [
        { orderId: "o-2", customerId: "c-1", total: 25 },
        { orderId: "o-1", customerId: "c-1", total: 10 },
      ],
      outstanding: 35,
    });
  });

  it("lets a handler compose other queries and work without a repository or payload", async () => {
    const runner = await setup();
    expect(await runner.facade.customerOverview?.({ customerId: "c-1" })).toEqual({
      customerId: "c-1",
      outstanding: 35,
    });
    expect(await runner.facade.countOrders?.()).toBe(3);
  });

  it("validates payloads and rejects unknown queries", async () => {
    const runner = await setup();
    await expect(runner.run({ type: "GetOrder", payload: {} })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(runner.run({ type: "Nope", payload: {} })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("buildQueries", () => {
  it("rejects duplicate query keys across read models", async () => {
    const duplicated: Registry = {
      aggregates: {},
      readModels: {
        a: { view, projections: {}, queries: { getOrder: { handler: () => null } } },
        b: { view, projections: {}, queries: { getOrder: { handler: () => null } } },
      },
    };
    const readModels = await buildReadModels({
      registry: duplicated,
      config: resolveConfig({ storage: memory() }),
      logger: silentLogger,
    });
    expect(() => buildQueries({ readModels })).toThrow(
      new ConfigurationError('Query "getOrder" is defined in both "a" and "b"'),
    );
  });
});
