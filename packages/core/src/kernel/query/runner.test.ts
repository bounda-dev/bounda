import { describe, expect, it } from "vitest";
import type { Table } from "../../adapter/storage/table.ts";
import { resolveConfig } from "../../config/schema.ts";
import { ConfigurationError, NotFoundError, ValidationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import type { ModulePorts } from "../ports/ports.ts";
import { buildReadModels } from "../read-model/build-read-models.ts";
import { unrecordedAccess } from "../test-support.ts";
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

type Rates = (args: { readonly from: string; readonly to: string }) => Promise<number>;

const seenByRepository: string[][] = [];

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
        whoAsks: {
          repository: ({ actor }: { actor: string | undefined }) => actor,
          handler: ({
            repositoryData,
            actor,
          }: {
            repositoryData: string | undefined;
            actor: string | undefined;
          }) => ({ repository: repositoryData, handler: actor }),
        },
        whoAsksBelow: {
          handler: ({ queries }: { queries: Record<string, () => Promise<unknown>> }) =>
            queries.whoAsks?.(),
        },
        getOrderInUsd: {
          payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
          repository: (args: Record<string, unknown>) => {
            seenByRepository.push(Object.keys(args).sort());
            return (args.table as Table<Row>).findOne({ orderId: args.orderId as string });
          },
          handler: async ({ repositoryData, rates }: { repositoryData: Row; rates: Rates }) => ({
            orderId: repositoryData.orderId,
            totalUsd: repositoryData.total * (await rates({ from: "EUR", to: "USD" })),
          }),
        },
      },
    },
  },
};

const setup = async (ports: ModulePorts = {}) => {
  const config = resolveConfig({ storage: memory() });
  const readModels = await buildReadModels({ registry, config, logger: silentLogger });
  const table = readModels.byName.orderSummary?.storage.table as unknown as Table<Row>;
  await table.insert({ orderId: "o-1", customerId: "c-1", total: 10 });
  await table.insert({ orderId: "o-2", customerId: "c-1", total: 25 });
  await table.insert({ orderId: "o-3", customerId: "c-2", total: 5 });
  return createQueryRunner({
    queries: buildQueries({ readModels }),
    readModels,
    ports,
    recordAccess: unrecordedAccess,
    errorText: "omit",
  });
};

describe("query runner", () => {
  it("runs repository then handler with the validated payload", async () => {
    const runner = await setup();
    expect(await runner.run({ type: "GetOrder", payload: { orderId: "o-2" } })).toEqual({
      orderId: "o-2",
      customerId: "c-1",
      total: 25,
    });
    expect(await runner.facade(undefined).listOrders?.({ customerId: "c-1" })).toEqual({
      orders: [
        { orderId: "o-2", customerId: "c-1", total: 25 },
        { orderId: "o-1", customerId: "c-1", total: 10 },
      ],
      outstanding: 35,
    });
  });

  it("lets a handler compose other queries and work without a repository or payload", async () => {
    const runner = await setup();
    expect(await runner.facade(undefined).customerOverview?.({ customerId: "c-1" })).toEqual({
      customerId: "c-1",
      outstanding: 35,
    });
    expect(await runner.facade(undefined).countOrders?.()).toBe(3);
  });

  it("hands the actor of the client to the repository and the handler, and to queries a handler composes", async () => {
    const runner = await setup();
    expect(await runner.facade("agent-7").whoAsks?.()).toEqual({
      repository: "agent-7",
      handler: "agent-7",
    });
    expect(await runner.facade("agent-7").whoAsksBelow?.()).toEqual({
      repository: "agent-7",
      handler: "agent-7",
    });
    expect(await runner.run({ type: "WhoAsks", payload: undefined, actor: "agent-8" })).toEqual({
      repository: "agent-8",
      handler: "agent-8",
    });
    expect(await runner.facade(undefined).whoAsks?.()).toEqual({
      repository: undefined,
      handler: undefined,
    });
  });

  it("hands a read model's ports to its query handlers, never to their repository", async () => {
    const runner = await setup({ orderSummary: { rates: async () => 1.5 } });
    seenByRepository.length = 0;
    expect(await runner.facade(undefined).getOrderInUsd?.({ orderId: "o-2" })).toEqual({
      orderId: "o-2",
      totalUsd: 37.5,
    });
    expect(seenByRepository).toEqual([["actor", "client", "orderId", "table"]]);
  });

  it("throws a port that was given nothing only in the query that reads it", async () => {
    const missing = new ConfigurationError("rates was given none");
    const ports: ModulePorts = {
      orderSummary: Object.defineProperty({}, "rates", {
        enumerable: true,
        get: () => {
          throw missing;
        },
      }),
    };
    const runner = await setup(ports);
    expect(await runner.facade(undefined).countOrders?.()).toBe(3);
    await expect(runner.facade(undefined).getOrderInUsd?.({ orderId: "o-2" })).rejects.toBe(
      missing,
    );
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

  it("rejects payload functions that do not return a schema", async () => {
    const broken: Registry = {
      aggregates: {},
      readModels: {
        a: {
          view,
          projections: {},
          queries: { getOrder: { payload: (() => "nope") as never, handler: () => null } },
        },
      },
    };
    const readModels = await buildReadModels({
      registry: broken,
      config: resolveConfig({ storage: memory() }),
      logger: silentLogger,
    });
    expect(() => buildQueries({ readModels })).toThrow(
      new ConfigurationError("readModels.a.queries.getOrder: payload must return a Zod schema"),
    );
  });

  it("rejects a payload field a repository receives as its own argument", async () => {
    const withPayload = (fields: readonly string[], repository: boolean) =>
      buildReadModels({
        registry: {
          aggregates: {},
          readModels: {
            a: {
              view,
              projections: {},
              queries: {
                byActor: {
                  payload: ({ z }: PayloadArgs) =>
                    z.object(Object.fromEntries(fields.map((field) => [field, z.string()]))),
                  ...(repository ? { repository: () => null } : {}),
                  handler: () => null,
                },
              },
            },
          },
        },
        config: resolveConfig({ storage: memory() }),
        logger: silentLogger,
      });
    for (const field of ["client", "table", "actor"]) {
      const readModels = await withPayload(["orderId", field], true);
      expect(() => buildQueries({ readModels })).toThrow(
        new ConfigurationError(
          `readModels.a.queries.byActor: payload field "${field}" is what the repository receives as its own ${field}; give the field another name`,
        ),
      );
    }
    const transformed = await buildReadModels({
      registry: {
        aggregates: {},
        readModels: {
          a: {
            view,
            projections: {},
            queries: {
              byActor: {
                payload: ({ z }: PayloadArgs) =>
                  z.object({ actor: z.string() }).transform((payload) => payload),
                repository: () => null,
                handler: () => null,
              },
            },
          },
        },
      },
      config: resolveConfig({ storage: memory() }),
      logger: silentLogger,
    });
    const runner = createQueryRunner({
      queries: buildQueries({ readModels: transformed }),
      readModels: transformed,
      ports: {},
      recordAccess: unrecordedAccess,
      errorText: "omit",
    });
    await expect(runner.run({ type: "ByActor", payload: { actor: "a" } })).rejects.toThrow(
      new ConfigurationError(
        'readModels.a.queries.byActor: payload field "actor" is what the repository receives as its own actor; give the field another name',
      ),
    );
    const handlerOnly = await withPayload(["actor"], false);
    expect(Object.keys(buildQueries({ readModels: handlerOnly }).byKey)).toEqual(["byActor"]);
    const handlerRunner = createQueryRunner({
      queries: buildQueries({ readModels: handlerOnly }),
      readModels: handlerOnly,
      ports: {},
      recordAccess: unrecordedAccess,
      errorText: "omit",
    });
    expect(await handlerRunner.run({ type: "ByActor", payload: { actor: "a" } })).toBeNull();
    const named = await withPayload(["actorId"], true);
    expect(Object.keys(buildQueries({ readModels: named }).byKey)).toEqual(["byActor"]);
  });
});
