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
  readModelRebuildContract,
  readModelTransactionContract,
  schedulerContract,
  tableContract,
} from "@bounda-dev/core/adapter/testing";
import { createTestApp } from "@bounda-dev/core/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type PostgresqlAdapter,
  type PostgresqlOptions,
  postgresql,
  resolvePostgresqlOptions,
} from "./index.ts";

const reuseContainer = process.env.BOUNDA_PG_REUSE === "1";

const startContainer = async (): Promise<StartedPostgreSqlContainer | null> => {
  try {
    const definition = new PostgreSqlContainer("postgres:17");
    return await (reuseContainer ? definition.withReuse() : definition).start();
  } catch {
    return null;
  }
};

const container = await startContainer();
const url = container?.getConnectionUri() ?? "";
const run = Date.now().toString(36);
const closers: (() => Promise<void>)[] = [];
let prefixes = 0;

const fresh = (options: Partial<PostgresqlOptions> = {}): PostgresqlAdapter => {
  prefixes += 1;
  return postgresql({
    url,
    tablePrefix: `t${run}_${prefixes}_`,
    maxConnections: 2,
    ...options,
  });
};

const closeOpened = async (): Promise<void> => {
  await Promise.all(closers.splice(0).map((close) => close()));
};

const openStorage = async (adapter?: PostgresqlAdapter): Promise<StoragePorts> => {
  if (adapter === undefined) await closeOpened();
  const storage = await (adapter ?? fresh()).createStorage({ logger: silentLogger });
  closers.push(storage.close);
  return storage;
};

const openReadModel = async <Row extends object>(
  adapter: PostgresqlAdapter,
  name: string,
  fields: Parameters<PostgresqlAdapter["createReadModel"]>[0]["fields"],
  logger = silentLogger,
) => {
  const ports = await adapter.createReadModel<Row>({ name, fields, logger });
  closers.push(ports.close);
  return ports;
};

afterAll(async () => {
  await closeOpened();
  if (!reuseContainer) await container?.stop();
});

describe.skipIf(container === null)("postgresql adapter", () => {
  eventStoreContract({ create: async () => (await openStorage()).eventStore });
  checkpointStoreContract({ create: async () => (await openStorage()).checkpointStore });
  inboxLedgerContract({ create: async () => (await openStorage()).inboxLedger });
  deadLetterStoreContract({ create: async () => (await openStorage()).deadLetterStore });
  schedulerContract({ create: async () => (await openStorage()).scheduler });
  tableContract({
    create: async () => {
      await closeOpened();
      return (
        await openReadModel<{
          readonly orderId: string;
          readonly customerId: string;
          readonly status: string;
          readonly total: number;
          readonly paidAt?: Date;
        }>(fresh(), "orderSummary", contractFields)
      ).table;
    },
  });
  readModelRebuildContract({
    create: async () => {
      await closeOpened();
      return fresh();
    },
  });
  readModelTransactionContract({
    create: async () => {
      await closeOpened();
      return fresh();
    },
    locking: "per-subscriber",
  });

  it("notifies listeners of every committed append with the last position", async () => {
    const storage = await openStorage();
    const notifier = storage.notifier as NonNullable<typeof storage.notifier>;
    const heard: (number | undefined)[] = [];
    const stop = await notifier.subscribe((position) => {
      heard.push(position);
    });
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "n-1",
      expectedVersion: 0,
      events: [1, 2].map((version) => pendingEvent({ aggregateId: "n-1", version })),
    });
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "n-1",
      expectedVersion: 2,
      events: [],
    });
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "n-2",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "n-2", version: 1 })],
    });
    await vi.waitFor(() => expect(heard).toEqual([2, 3]), { timeout: 5_000 });

    const witnessed: (number | undefined)[] = [];
    const stopWitness = await notifier.subscribe((position) => {
      witnessed.push(position);
    });
    await stop();
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "n-3",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "n-3", version: 1 })],
    });
    await vi.waitFor(() => expect(witnessed).toEqual([4]), { timeout: 5_000 });
    expect(heard).toEqual([2, 3]);
    await stopWitness();
  });

  it("reports the stream version even when loading past its end", async () => {
    const { eventStore } = await openStorage();
    await eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [1, 2, 3].map((version) => pendingEvent({ aggregateId: "1", version })),
    });
    expect(
      await eventStore.load({ aggregateType: "order", aggregateId: "1", fromVersion: 5 }),
    ).toEqual({ events: [], version: 3 });
  });

  it("leaves lastError out of a claim that never failed", async () => {
    const { inboxLedger } = await openStorage();
    const key = { subscriber: "policies", eventId: "e-1" };
    await inboxLedger.tryClaim({ ...key, now: new Date(), leaseMs: 1_000 });
    expect(await inboxLedger.get(key)).not.toHaveProperty("lastError");
    await inboxLedger.fail({ ...key, error: "boom" });
    expect(await inboxLedger.get(key)).toMatchObject({ lastError: "boom" });
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
    const schema = `s_${run}`;
    const adapter = fresh({ schema });
    await openStorage(adapter);
    const readModel = await openReadModel(adapter, "orderSummary", contractFields);
    const sql = readModel.client.raw as Sql;
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} ORDER BY table_name
    `;
    expect(tables.map((row) => String(row.table_name).replace(/^t[a-z0-9]+_\d+_/, ""))).toEqual([
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
    const prefix = `t${run}_${prefixes}_`;
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

  it("adds the columns a database created by an earlier version lacks", async () => {
    await closeOpened();
    const adapter = fresh();
    const prefix = `t${run}_${prefixes}_`;
    const first = await adapter.createStorage({ logger: silentLogger });
    await first.close();
    const probe = await openReadModel(adapter, "probe", contractFields);
    await (probe.client.raw as Sql).unsafe(
      `ALTER TABLE "${prefix}dead_letters" DROP COLUMN "payload"`,
    );
    await closeOpened();

    const storage = await openStorage(adapter);
    const letter = await storage.deadLetterStore.add({
      id: "cmd",
      kind: "command",
      subscriber: "scheduled:PlaceOrder",
      eventId: "k",
      eventType: "PlaceOrder",
      aggregateType: "order",
      aggregateId: "o-1",
      errorType: "terminal",
      errorMessage: "nope",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
      payload: { orderId: "o-1" },
    });
    expect(letter.payload).toEqual({ orderId: "o-1" });
  });

  it("logs the lifecycle of a rebuild with the tables involved", async () => {
    await closeOpened();
    const adapter = fresh();
    const prefix = `t${run}_${prefixes}_`;
    const logs: unknown[] = [];
    const logger = {
      ...silentLogger,
      info: (message: string, fields?: unknown) => {
        logs.push([message, fields]);
      },
    };
    const args = { name: "orderSummary", fields: contractFields, logger, progress: "rebuild:1" };
    const committed = await adapter.rebuildReadModel(args);
    await committed.commit({ subscriber: "projection:orderSummary", position: 0 });
    const paused = await adapter.rebuildReadModel(args);
    await paused.transact(({ checkpointStore }) => checkpointStore.set(args.progress, 1));
    await paused.pause();
    const superseded = await adapter.rebuildReadModel(args);
    const aborted = await adapter.rebuildReadModel(args);
    await superseded.abort();
    await aborted.abort();
    const table = `${prefix}order_summary`;
    const shadow = `${table}__rebuild`;
    expect(logs).toEqual([
      ["read model rebuild started", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild committed", { readModel: "orderSummary", table }],
      ["read model rebuild started", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild paused", { readModel: "orderSummary", table }],
      ["read model rebuild resumed", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild resumed", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild superseded", { readModel: "orderSummary", table }],
      ["read model rebuild aborted", { readModel: "orderSummary", table }],
    ]);
    const ports = await openReadModel(adapter, "orderSummary", contractFields);
    const tables = await ports.client.all(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE $1 ORDER BY table_name",
      [`${table}%`],
    );
    expect(tables).toEqual([{ tableName: table }]);
  });

  it("evolves a read model table additively and refuses destructive changes", async () => {
    const adapter = fresh();
    const prefix = `t${run}_${prefixes}_`;
    const logs: unknown[] = [];
    const logger = {
      ...silentLogger,
      info: (message: string, fields?: unknown) => {
        logs.push([message, fields]);
      },
    };
    const v1 = { id: f.string().primaryKey(), total: f.number() };
    const first = await openReadModel<{ id: string; total: number }>(adapter, "orders", v1, logger);
    await first.table.insert({ id: "o-1", total: 5 });
    expect(logs).toEqual([]);

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
    }>(adapter, "orders", v2, logger);
    expect(logs).toEqual([
      ["read model table evolved", { readModel: "orders", table: `${prefix}orders`, added: 4 }],
    ]);
    expect(await second.table.findOne({ id: "o-1" })).toEqual({ id: "o-1", total: 5 });
    const at = new Date("2026-01-01T00:00:00.000Z");
    await second.table.upsert({ id: "o-1", total: 5, paid: true, at });
    expect(await second.table.findOne({ id: "o-1" })).toEqual({
      id: "o-1",
      total: 5,
      paid: true,
      at,
    });
    const third = await openReadModel(adapter, "orders", v2, logger);
    expect(await third.table.count()).toBe(1);
    expect(logs).toHaveLength(1);

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
    ).rejects.toThrow(/Changing a field's type needs a rebuild: run `bounda rebuild orders`/);
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
    const parts = resolvePostgresqlOptions({
      host: "h",
      database: "db",
      user: "u",
      schema: "app",
      maxConnections: 2,
    });
    expect(parts).toEqual({
      host: "h",
      database: "db",
      user: "u",
      schema: "app",
      tablePrefix: "bounda_",
      maxConnections: 2,
    });
    expect(parts).not.toHaveProperty("port");
    expect(parts).not.toHaveProperty("password");
    expect(parts).not.toHaveProperty("ssl");
    expect(
      resolvePostgresqlOptions({
        host: "h",
        port: 5433,
        database: "db",
        user: "u",
        password: "p",
        ssl: true,
        tablePrefix: "x_",
      }),
    ).toEqual({
      host: "h",
      port: 5433,
      database: "db",
      user: "u",
      password: "p",
      ssl: true,
      schema: "public",
      tablePrefix: "x_",
      maxConnections: 10,
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
              `SELECT order_id, status, total FROM "app_${run}_order_summary" WHERE order_id = $1`,
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
      adapter: postgresql({ url, tablePrefix: `app_${run}_`, maxConnections: 5 }),
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

interface StatusRow {
  readonly orderId: string;
  readonly status: string;
}

interface CountRow {
  readonly id: string;
  readonly placed: number;
}

interface HoldProjection {
  (): Promise<void>;
}

const statusRegistry = (hold: HoldProjection = async () => {}) =>
  ({
    aggregates: {
      order: {
        state: { initialState: {} },
        events: {
          orderPlaced: { apply: ({ state }: { state: object }) => state },
          orderCancelled: { apply: ({ state }: { state: object }) => state },
        },
        commands: {
          placeOrder: {
            module: {
              payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
              handler: ({ events }: { events: Record<string, (payload?: unknown) => unknown> }) => [
                events.orderPlaced?.(),
              ],
            },
          },
          cancelOrder: {
            module: {
              payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
              handler: ({ events }: { events: Record<string, (payload?: unknown) => unknown> }) => [
                events.orderCancelled?.(),
              ],
            },
          },
        },
        policies: {},
        processes: {},
      },
    },
    readModels: {
      orderStatus: {
        view: {
          fields: ({ f: fields }: FieldsArgs) => ({
            orderId: fields.string().primaryKey(),
            status: fields.string(),
          }),
        },
        projections: {
          orderPlaced: {
            project: async ({
              event,
              table,
            }: {
              event: { aggregateId: string };
              table: Table<StatusRow>;
            }) => {
              await hold();
              await table.upsert({ orderId: event.aggregateId, status: "placed" });
            },
          },
          orderCancelled: {
            project: async ({
              event,
              table,
            }: {
              event: { aggregateId: string };
              table: Table<StatusRow>;
            }) => {
              await table.update({ orderId: event.aggregateId }, { status: "cancelled" });
            },
          },
        },
        queries: {},
      },
    },
  }) as const satisfies Registry;

const counterRegistry = (failOnce: { failed: boolean }) =>
  ({
    aggregates: statusRegistry().aggregates,
    readModels: {
      orderCount: {
        view: {
          fields: ({ f: fields }: FieldsArgs) => ({
            id: fields.string().primaryKey(),
            placed: fields.number(),
          }),
        },
        projections: {
          orderPlaced: {
            project: async ({ table }: { table: Table<CountRow> }) => {
              const row = await table.findOne({ id: "all" });
              await table.upsert({ id: "all", placed: (row?.placed ?? 0) + 1 });
            },
          },
          orderCancelled: {
            project: async () => {
              if (failOnce.failed) return;
              failOnce.failed = true;
              throw new Error("transient");
            },
          },
        },
        queries: {},
      },
    },
  }) as const satisfies Registry;

describe.skipIf(container === null)("projections on postgresql", () => {
  it("keeps a read model right when a slower instance applies a batch another already moved past", async () => {
    await closeOpened();
    const tablePrefix = `race_${run}_`;
    const adapter = () => postgresql({ url, tablePrefix, maxConnections: 3 });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => {};
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fast = await createTestApp({ registry: statusRegistry(), adapter: adapter() });
    const slow = await createTestApp({
      registry: statusRegistry(async () => {
        entered();
        await gate;
      }),
      adapter: adapter(),
    });

    const { table, client } = await openReadModel<StatusRow>(adapter(), "orderStatus", {
      orderId: f.string().primaryKey(),
      status: f.string(),
    });
    const sql = client.raw as Sql;
    const waitingForLock = async () =>
      (
        await sql`SELECT count(*)::int AS "n" FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
      )[0]?.n;

    await fast.app.commands.placeOrder({ orderId: "r" });
    const lagging = slow.app.catchUpReadModels();
    await holding;
    await fast.app.commands.cancelOrder({ orderId: "r" });
    const waiting = fast.app.catchUpReadModels();
    await vi.waitFor(async () => expect(await waitingForLock()).toBe(1), { timeout: 5_000 });
    release();
    await Promise.all([lagging, waiting]);
    const lag = await fast.app.getLag();
    await Promise.all([fast.app.stop(), slow.app.stop()]);
    expect({ row: await table.findOne({ orderId: "r" }), maxLag: lag.maxLag }).toEqual({
      row: { orderId: "r", status: "cancelled" },
      maxLag: 0,
    });
  });

  it("applies every event of a redelivered batch once, even to a read-modify-write projection", async () => {
    await closeOpened();
    const tablePrefix = `redeliver_${run}_`;
    const adapter = () => postgresql({ url, tablePrefix, maxConnections: 3 });
    const { app } = await createTestApp({
      registry: counterRegistry({ failed: false }),
      adapter: adapter(),
    });

    await app.commands.placeOrder({ orderId: "r" });
    await app.commands.cancelOrder({ orderId: "r" });
    await app.catchUpReadModels();
    await app.catchUpReadModels();

    const { table } = await openReadModel<CountRow>(adapter(), "orderCount", {
      id: f.string().primaryKey(),
      placed: f.number(),
    });
    const lag = await app.getLag();
    await app.stop();
    expect({ row: await table.findOne({ id: "all" }), maxLag: lag.maxLag }).toEqual({
      row: { id: "all", placed: 1 },
      maxLag: 0,
    });
  });

  it("rolls hand-written SQL on client.raw back with the rest of the batch", async () => {
    await closeOpened();
    const adapter = fresh();
    const prefix = `t${run}_${prefixes}_`;
    const ports = await openReadModel<StatusRow>(adapter, "orderStatus", {
      orderId: f.string().primaryKey(),
      status: f.string(),
    });
    await expect(
      ports.transact({
        subscriber: "projection:orderStatus",
        wait: true,
        work: async ({ client, checkpointStore }) => {
          const tx = client.raw as Sql;
          await tx.unsafe(
            `INSERT INTO "${prefix}order_status" (order_id, status) VALUES ('r', 'x')`,
          );
          expect(await client.get(`SELECT * FROM "${prefix}order_status"`)).toEqual({
            orderId: "r",
            status: "x",
          });
          await checkpointStore.compareAndSet("projection:orderStatus", 0, 1);
          throw new Error("later projection failed");
        },
      }),
    ).rejects.toThrow("later projection failed");
    expect(await ports.table.count()).toBe(0);
    expect(await ports.checkpointStore.get("projection:orderStatus")).toBe(0);
  });

  it("projects on a pool of one connection without waiting on itself", async () => {
    await closeOpened();
    const { app } = await createTestApp({
      registry: statusRegistry(),
      adapter: postgresql({ url, tablePrefix: `single_${run}_`, maxConnections: 1 }),
    });
    await app.commands.placeOrder({ orderId: "r" });
    await app.commands.cancelOrder({ orderId: "r" });
    await app.processUntilIdle();
    const lag = await app.getLag();
    await app.stop();
    expect(lag.maxLag).toBe(0);
  });

  it("keeps a newer rebuild and a rebuild's swap waiting on the lock of what is in flight", async () => {
    await closeOpened();
    const adapter = fresh();
    const fields = { orderId: f.string().primaryKey(), status: f.string() };
    const ports = await openReadModel<StatusRow>(adapter, "orderStatus", fields);
    const probe = postgres(url, { max: 1, onnotice: () => undefined });
    closers.push(() => probe.end());
    const waiting = async () =>
      (
        await probe`SELECT count(*)::int AS "n" FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
      )[0]?.n;
    const gate = () => {
      let open = (): void => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { opened, open };
    };
    const args = { name: "orderStatus", fields, logger: silentLogger, progress: "rebuild:o:1" };

    const older = await adapter.rebuildReadModel<StatusRow>(args);
    const held = gate();
    const entered = gate();
    const batch = older.transact(async ({ table, checkpointStore }) => {
      await table.upsert({ orderId: "r", status: "placed" });
      await checkpointStore.set(args.progress, 1);
      entered.open();
      await held.opened;
    });
    await entered.opened;
    const opening = adapter.rebuildReadModel<StatusRow>(args);
    await vi.waitFor(async () => expect(await waiting()).toBe(1), { timeout: 5_000 });
    held.open();
    await batch;
    const newer = await opening;
    expect({ resumed: newer.resumed, position: newer.position }).toEqual({
      resumed: true,
      position: 1,
    });

    const projecting = gate();
    const inside = gate();
    const projection = ports.transact({
      subscriber: "projection:orderStatus",
      wait: true,
      work: async ({ table }) => {
        await table.upsert({ orderId: "r", status: "cancelled" });
        inside.open();
        await projecting.opened;
      },
    });
    await inside.opened;
    const committing = newer.commit({ subscriber: "projection:orderStatus", position: 1 });
    await vi.waitFor(async () => expect(await waiting()).toBe(1), { timeout: 5_000 });
    projecting.open();
    await Promise.all([projection, committing]);
    await older.abort();
    expect(await ports.table.findMany()).toEqual([{ orderId: "r", status: "placed" }]);
    expect(await ports.checkpointStore.get("projection:orderStatus")).toBe(1);
  });
});
