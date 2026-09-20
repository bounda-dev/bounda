import {
  ConfigurationError,
  type FieldsArgs,
  fieldBuilder as f,
  type PayloadArgs,
  type Registry,
  silentLogger,
  type Table,
} from "@bounda-dev/core";
import type { StoragePorts } from "@bounda-dev/core/adapter";
import {
  checkpointStoreContract,
  contractFields,
  deadLetterStoreContract,
  eventStoreContract,
  inboxLedgerContract,
  pendingEvent,
  schedulerContract,
  tableContract,
} from "@bounda-dev/core/adapter/testing";
import { createTestApp } from "@bounda-dev/core/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Sql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import {
  type PostgresqlAdapter,
  type PostgresqlOptions,
  postgresql,
  resolvePostgresqlOptions,
} from "./index.ts";

const startContainer = async (): Promise<StartedPostgreSqlContainer | null> => {
  try {
    return await new PostgreSqlContainer("postgres:17").start();
  } catch {
    return null;
  }
};

const container = await startContainer();
const url = container?.getConnectionUri() ?? "";
const closers: (() => Promise<void>)[] = [];
let prefixes = 0;

const fresh = (options: Partial<PostgresqlOptions> = {}): PostgresqlAdapter => {
  prefixes += 1;
  return postgresql({ url, tablePrefix: `t${prefixes}_`, maxConnections: 5, ...options });
};

const openStorage = async (adapter: PostgresqlAdapter = fresh()): Promise<StoragePorts> => {
  const storage = await adapter.createStorage({ logger: silentLogger });
  closers.push(storage.close);
  return storage;
};

const openReadModel = async <Row extends object>(
  adapter: PostgresqlAdapter,
  name: string,
  fields: Parameters<PostgresqlAdapter["createReadModel"]>[0]["fields"],
) => {
  const ports = await adapter.createReadModel<Row>({ name, fields, logger: silentLogger });
  closers.push(ports.close);
  return ports;
};

afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
  await container?.stop();
});

describe.skipIf(container === null)("postgresql adapter", () => {
  eventStoreContract({ create: async () => (await openStorage()).eventStore });
  checkpointStoreContract({ create: async () => (await openStorage()).checkpointStore });
  inboxLedgerContract({ create: async () => (await openStorage()).inboxLedger });
  deadLetterStoreContract({ create: async () => (await openStorage()).deadLetterStore });
  schedulerContract({ create: async () => (await openStorage()).scheduler });
  tableContract({
    create: async () =>
      (
        await openReadModel<{
          readonly orderId: string;
          readonly customerId: string;
          readonly status: string;
          readonly total: number;
          readonly paidAt?: Date;
        }>(fresh(), "orderSummary", contractFields)
      ).table,
  });

  it("hands out gap-free positions in commit order to a reader racing 20 writers", async () => {
    const { eventStore } = await openStorage(fresh({ maxConnections: 10 }));
    const writers = Array.from({ length: 20 }, (_, index) =>
      (async () => {
        for (let version = 1; version <= 5; version += 1) {
          await eventStore.append({
            aggregateType: "order",
            aggregateId: `w-${index}`,
            expectedVersion: version - 1,
            events: [pendingEvent({ aggregateId: `w-${index}`, version })],
          });
        }
      })(),
    );
    const seen: number[] = [];
    const reader = (async () => {
      let last = 0;
      while (seen.length < 100) {
        const batch = await eventStore.readAll({ afterPosition: last, limit: 7 });
        for (const event of batch) {
          expect(event.position).toBe(last + 1);
          last = event.position;
          seen.push(last);
        }
        if (batch.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    await Promise.all([...writers, reader]);
    expect(seen).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(await eventStore.lastPosition()).toBe(100);
  });

  it("keeps every table in the configured schema", async () => {
    const adapter = fresh({ schema: "bounda_test" });
    await openStorage(adapter);
    const readModel = await openReadModel(adapter, "orderSummary", contractFields);
    const sql = readModel.client.raw as Sql;
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'bounda_test' ORDER BY table_name
    `;
    expect(tables.map((row) => String(row.table_name).replace(/^t\d+_/, ""))).toEqual([
      "checkpoints",
      "dead_letters",
      "events",
      "inbox",
      "order_summary",
      "scheduled_commands",
    ]);
  });

  it("round-trips booleans, dates and json through native columns", async () => {
    const fields = {
      id: f.string().primaryKey(),
      active: f.boolean(),
      since: f.date(),
      tags: f.json<readonly string[]>().optional(),
    };
    const adapter = fresh();
    const prefix = `t${prefixes}_`;
    const { table, client } = await openReadModel<{
      id: string;
      active: boolean;
      since: Date;
      tags?: readonly string[];
    }>(adapter, "flags", fields);
    const since = new Date("2026-03-04T05:06:07.000Z");
    await table.insert({ id: "a", active: true, since, tags: ["x", "y"] });
    await table.insert({ id: "b", active: false, since });
    expect(await table.findMany({ orderBy: { field: "id", direction: "asc" } })).toEqual([
      { id: "a", active: true, since, tags: ["x", "y"] },
      { id: "b", active: false, since },
    ]);
    expect(await table.findMany({ where: { active: false } })).toEqual([
      { id: "b", active: false, since },
    ]);
    await table.update({ id: "b" }, { tags: [] });
    expect(await table.findOne({ id: "b" })).toEqual({ id: "b", active: false, since, tags: [] });
    const [row] = await client.all(`SELECT id, tags, since FROM "${prefix}flags" WHERE id = $1`, [
      "a",
    ]);
    expect(row).toEqual({ id: "a", tags: ["x", "y"], since });
  });

  it("evolves a read model table additively and refuses destructive changes", async () => {
    const adapter = fresh();
    const v1 = { id: f.string().primaryKey(), total: f.number() };
    const first = await openReadModel<{ id: string; total: number }>(adapter, "orders", v1);
    await first.table.insert({ id: "o-1", total: 5 });

    const v2 = {
      ...v1,
      note: f.string().optional(),
      paid: f.boolean().index(),
      at: f.date().optional(),
    };
    const second = await openReadModel<{
      id: string;
      total: number;
      note?: string;
      paid: boolean;
      at?: Date;
    }>(adapter, "orders", v2);
    expect(await second.table.findOne({ id: "o-1" })).toEqual({ id: "o-1", total: 5 });
    const at = new Date("2026-01-01T00:00:00.000Z");
    await second.table.upsert({ id: "o-1", total: 5, paid: true, at });
    expect(await second.table.findOne({ id: "o-1" })).toEqual({
      id: "o-1",
      total: 5,
      paid: true,
      at,
    });
    const third = await openReadModel(adapter, "orders", v2);
    expect(await third.table.count()).toBe(1);

    await expect(
      adapter.createReadModel({
        name: "orders",
        fields: { id: f.string().primaryKey() },
        logger: silentLogger,
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      adapter.createReadModel({
        name: "orders",
        fields: { ...v2, total: f.string() },
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Changing a field's type is not supported yet/);
  });

  it("shares one pool between storage and read models until the last close", async () => {
    const adapter = fresh();
    const storage = await adapter.createStorage({ logger: silentLogger });
    const readModel = await adapter.createReadModel({
      name: "orderSummary",
      fields: contractFields,
      logger: silentLogger,
    });
    await storage.close();
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1 })],
    });
    expect(await storage.eventStore.lastPosition()).toBe(1);
    await readModel.close();
    await expect(storage.eventStore.lastPosition()).rejects.toThrow();
  });
});

describe("resolvePostgresqlOptions", () => {
  it("fills defaults and drops undefined parts", () => {
    expect(resolvePostgresqlOptions({ url: "postgres://u:p@h:5432/db" })).toEqual({
      url: "postgres://u:p@h:5432/db",
      schema: "public",
      tablePrefix: "bounda_",
      maxConnections: 10,
    });
    expect(
      resolvePostgresqlOptions({
        host: "h",
        database: "db",
        user: "u",
        schema: "app",
        maxConnections: 2,
      }),
    ).toEqual({
      host: "h",
      database: "db",
      user: "u",
      schema: "app",
      tablePrefix: "bounda_",
      maxConnections: 2,
    });
  });
});

interface OrderState {
  readonly status: "new" | "placed" | "paid";
}

interface Row {
  readonly orderId: string;
  readonly status: string;
  readonly total: number;
}

const registry = {
  aggregates: {
    order: {
      state: { initialState: { status: "new" } satisfies OrderState },
      events: {
        orderPlaced: {
          payload: ({ z }: PayloadArgs) => z.object({ total: z.number() }),
          apply: ({ state }: { state: OrderState }) => ({ ...state, status: "placed" as const }),
        },
        orderPaid: {
          apply: ({ state }: { state: OrderState }) => ({ ...state, status: "paid" as const }),
        },
      },
      commands: {
        placeOrder: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string(), total: z.number() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { total: number } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.orderPlaced?.({ total: command.payload.total })],
          },
        },
        payOrder: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
            handler: ({ events }: { events: Record<string, (payload?: unknown) => unknown> }) => [
              events.orderPaid?.(),
            ],
          },
        },
      },
      policies: {
        payOnOrderPlaced: {
          handler: async ({
            event,
            commands,
          }: {
            event: { aggregateId: string };
            commands: { payOrder: (payload: { orderId: string }) => Promise<unknown> };
          }) => {
            await commands.payOrder({ orderId: event.aggregateId });
          },
        },
      },
      processes: {},
    },
  },
  readModels: {
    orderSummary: {
      view: {
        fields: ({ f: fields }: FieldsArgs) => ({
          orderId: fields.string().primaryKey(),
          status: fields.string(),
          total: fields.number(),
        }),
      },
      projections: {
        orderPlaced: {
          project: async ({
            event,
            table,
          }: {
            event: { aggregateId: string; payload: { total: number } };
            table: Table<Row>;
          }) => {
            await table.upsert({
              orderId: event.aggregateId,
              status: "placed",
              total: event.payload.total,
            });
          },
        },
        orderPaid: {
          project: async ({
            event,
            table,
          }: {
            event: { aggregateId: string };
            table: Table<Row>;
          }) => {
            await table.update({ orderId: event.aggregateId }, { status: "paid" });
          },
        },
      },
      queries: {
        getOrder: {
          payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
          repository: ({
            orderId,
            client,
          }: {
            orderId: string;
            client: { get: (sql: string, params: unknown[]) => Promise<Row | null> };
          }) =>
            client.get(
              "SELECT order_id, status, total FROM app_order_summary WHERE order_id = $1",
              [orderId],
            ),
          handler: ({ repositoryData }: { repositoryData: Row | null }) => repositoryData,
        },
      },
    },
  },
} as const satisfies Registry;

describe.skipIf(container === null)("an app on the postgresql adapter", () => {
  it("runs commands, policies, projections, scheduled commands and SQL queries end to end", async () => {
    const { app, clock } = await createTestApp({
      registry,
      adapter: postgresql({ url, tablePrefix: "app_", maxConnections: 5 }),
    });
    await app.commands.placeOrder({ orderId: "o-1", total: 42 });
    await app.commands.placeOrder({ orderId: "o-2", total: 7 }, { delay: "1h" });
    await app.processUntilIdle();
    expect(await app.queries.getOrder({ orderId: "o-1" })).toEqual({
      orderId: "o-1",
      status: "paid",
      total: 42,
    });
    expect(await app.queries.getOrder({ orderId: "o-2" })).toBeNull();

    clock.advance(3_600_000);
    await app.processUntilIdle();
    expect(await app.queries.getOrder({ orderId: "o-2" })).toMatchObject({ status: "paid" });
    expect((await app.getLag()).maxLag).toBe(0);
    await app.stop();
  });
});
