import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigurationError,
  type FieldsArgs,
  fieldBuilder as f,
  type PayloadArgs,
  type Registry,
  silentLogger,
  type Table,
} from "@bounda-dev/core";
import type { Storage } from "@bounda-dev/core/adapter";
import {
  checkpointStoreContract,
  contractFields,
  deadLetterStoreContract,
  eventStoreContract,
  inboxLedgerContract,
  inspectionContract,
  pendingEvent,
  personalKeyStoreContract,
  personStoreContract,
  readModelRebuildContract,
  readModelTransactionContract,
  restrictedReadsContract,
  schedulerContract,
  snapshotStoreContract,
  storageSchemaContract,
  storageTransactionContract,
  subscriberFailureStoreContract,
  tableContract,
  viewContract,
} from "@bounda-dev/core/adapter/testing";
import { createTestApp } from "@bounda-dev/core/testing";
import { type Client, createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlite } from "./index.ts";
import { resolveSqliteOptions } from "./options.ts";

const openStorage = (adapter = sqlite({ memory: true })): Promise<Storage> =>
  adapter.createStorage();

describe("sqlite adapter in memory", () => {
  eventStoreContract({ create: openStorage });
  checkpointStoreContract({ create: async () => (await openStorage()).checkpointStore });
  inboxLedgerContract({ create: async () => (await openStorage()).inboxLedger });
  deadLetterStoreContract({ create: async () => (await openStorage()).deadLetterStore });
  schedulerContract({ create: async () => (await openStorage()).scheduler });
  snapshotStoreContract({ create: () => openStorage() });
  storageTransactionContract({ create: () => openStorage() });
  personalKeyStoreContract({ create: async () => openStorage() });
  personStoreContract({ create: async () => (await openStorage()).persons });
  subscriberFailureStoreContract({ create: async () => (await openStorage()).subscriberFailures });
  tableContract({
    create: async () =>
      (
        await sqlite({ memory: true }).createReadModel<{
          readonly orderId: string;
          readonly customerId: string;
          readonly status: string;
          readonly total: number;
          readonly paidAt?: Date;
        }>({ name: "orderSummary", fields: contractFields, logger: silentLogger })
      ).table,
  });
  viewContract({ create: async () => sqlite({ memory: true }) });
  inspectionContract({ create: async () => sqlite({ memory: true }) });
});

describe("sqlite adapter in memory, under concurrent use", () => {
  readModelTransactionContract({
    create: async () => sqlite({ memory: true }),
    locking: "single-writer",
  });
  restrictedReadsContract({ create: async () => sqlite({ memory: true }) });

  it("lets a read, its own or a query's on client.raw, wait for a write transaction in flight", async () => {
    const adapter = sqlite({ memory: true });
    const storage = await openStorage(adapter);
    const readModel = await adapter.createReadModel({
      name: "orderSummary",
      fields: contractFields,
      logger: silentLogger,
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writing = storage.transact(async (tx) => {
      await tx.eventStore.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "1", version: 1 })],
      });
      entered();
      await held;
    });
    await inside;
    const reading = storage.eventStore.lastPosition();
    const raw = readModel.client.raw as Client;
    expect(raw.closed).toBe(false);
    const querying = raw.execute("SELECT 1 AS one");
    release();
    await writing;
    expect(await reading).toBe(1);
    expect((await querying).rows[0]?.one).toBe(1);
  });
});

const OPENING_PROCESSES = 6;

// Opens the file's storage from processes of their own, each loaded first and then let go at
// once, so the first statements of every connection meet on the file: processes, as instances
// on several machines are, and as libSQL's native code wants, since a worker thread that ends
// under it can bring the whole process down. Resolves what each said.
const openTogether = async (path: string): Promise<readonly string[]> => {
  const children = Array.from({ length: OPENING_PROCESSES }, () =>
    spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { sqlite } from "./index.ts";
        process.stdout.write("loaded\\n");
        process.stdin.once("data", async () => {
          try {
            await (await sqlite({ path: ${JSON.stringify(path)} }).createStorage()).close();
            process.stdout.write("opened\\n");
          } catch (error) {
            process.stdout.write(String(error) + "\\n");
          }
          process.stdin.destroy();
        });`,
      ],
      { cwd: import.meta.dirname, stdio: ["pipe", "pipe", "inherit"] },
    ),
  );
  const said = children.map((child) => {
    const lines: string[] = [];
    let loaded: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        if (line === "loaded") loaded();
        else lines.push(line);
      }
    });
    const exited = new Promise<string>((resolve) => {
      child.once("exit", (code) => resolve(lines.join(" ") || `exited with ${code}`));
    });
    return { ready, exited };
  });
  await Promise.all(said.map(({ ready }) => ready));
  for (const child of children) child.stdin.write("go\n");
  return Promise.all(said.map(({ exited }) => exited));
};

describe("sqlite adapter on a file", () => {
  let directory: string;
  let counter = 0;
  const freshPath = (): string => {
    counter += 1;
    return join(directory, `db-${counter}.sqlite`);
  };

  // The storages a test leaves open are closed before the directory goes, so their files can go.
  const leftOpen: Storage[] = [];
  const afterAllClose: Client[] = [];
  const openFile = async (path = freshPath()): Promise<Storage> => {
    const storage = await openStorage(sqlite({ path }));
    leftOpen.push(storage);
    return storage;
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "bounda-sqlite-"));
  });

  afterAll(async () => {
    await Promise.all(leftOpen.map((storage) => storage.close()));
    for (const client of afterAllClose) client.close();
    // libSQL lets go of a file that saw a write transaction only once its statements are garbage
    // collected, and Windows cannot delete a file still open: there, those stay behind in the
    // temporary directory.
    await rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
      if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
    });
  });

  eventStoreContract({ create: openFile });
  schedulerContract({ create: async () => (await openFile()).scheduler });
  storageSchemaContract({
    create: async () => {
      const path = freshPath();
      const client = createClient({ url: `file:${path}` });
      afterAllClose.push(client);
      return {
        adapter: sqlite({ path }),
        prefix: "bounda_",
        execute: async (statement) => {
          const result = await client.execute(statement);
          return result.rows.map((row) =>
            Object.fromEntries(result.columns.map((column, index) => [column, row[index] ?? null])),
          );
        },
      };
    },
    dialect: "sqlite",
  });
  readModelRebuildContract({ create: async () => sqlite({ path: freshPath() }) });
  readModelTransactionContract({
    create: async () => sqlite({ path: freshPath() }),
    locking: "single-writer",
  });

  it("closes the file only once what runs on it has settled, a transaction in flight included", async () => {
    const path = freshPath();
    const adapter = sqlite({ path });
    const storage = await adapter.createStorage();
    const ledger = await adapter.createForgetLedger({});
    // Its table made, so its read below is one statement, queued behind the transaction.
    await ledger.read({ limit: 1 });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writing = storage.transact(async (tx) => {
      entered();
      await held;
      await tx.eventStore.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "1", version: 1 })],
      });
    });
    await inside;
    const reading = ledger.read({ limit: 1 });
    let closed = false;
    const closing = Promise.all([storage.close(), ledger.close?.()]).then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    release();
    await writing;
    expect(await reading).toEqual([]);
    await closing;
    const reopened = await openFile(path);
    expect(await reopened.eventStore.lastPosition()).toBe(1);
  });

  it("lets its own statements wait for its own write transaction, without blocking the process", async () => {
    const storage = await openFile();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writing = storage.transact(async (tx) => {
      await tx.eventStore.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "1", version: 1 })],
      });
      entered();
      await held;
    });
    await inside;
    const started = Date.now();
    const claiming = storage.checkpointStore.set("projection:x", 1);
    setTimeout(release, 20);
    await Promise.all([writing, claiming]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await storage.checkpointStore.get("projection:x")).toBe(1);
  });

  it("waits for another process's write on the file, in WAL mode, instead of failing", async () => {
    const path = freshPath();
    const storage = await openFile(path);
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createClient } from "@libsql/client";
        const client = createClient({ url: ${JSON.stringify(`file:${path}`)} });
        const tx = await client.transaction("write");
        await tx.execute("CREATE TABLE IF NOT EXISTS held (id INTEGER)");
        process.stdout.write("held\\n");
        setTimeout(async () => { await tx.commit(); client.close(); }, 300);`,
      ],
      { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1 })],
    });
    expect(await storage.eventStore.lastPosition()).toBe(1);
    await new Promise((resolve) => holder.once("exit", resolve));
    const readModel = await sqlite({ path }).createReadModel({
      name: "orderSummary",
      fields: contractFields,
      logger: silentLogger,
    });
    const [mode] = (await (readModel.client.raw as Client).execute("PRAGMA journal_mode")).rows;
    expect(mode?.[0]).toBe("wal");
    await readModel.close();
  });

  it("opens a file not in WAL yet, such as one just restored, from several processes at once", async () => {
    for (let round = 0; round < 3; round += 1) {
      const sourcePath = freshPath();
      const source = await openFile(sourcePath);
      await source.eventStore.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "1", version: 1 })],
      });
      const path = freshPath();
      const backup = createClient({ url: `file:${sourcePath}` });
      await backup.execute({ sql: "VACUUM INTO ?", args: [path] });
      backup.close();
      const restored = createClient({ url: `file:${path}` });
      expect((await restored.execute("PRAGMA journal_mode")).rows[0]?.[0]).toBe("delete");
      restored.close();

      expect(await openTogether(path)).toEqual(Array(OPENING_PROCESSES).fill("opened"));
      expect(await (await openFile(path)).eventStore.lastPosition()).toBe(1);
    }
  });

  it("migrates a new file once when processes open it at the same moment", async () => {
    const path = freshPath();
    expect(await openTogether(path)).toEqual(Array(OPENING_PROCESSES).fill("opened"));
    const client = createClient({ url: `file:${path}` });
    const { rows } = await client.execute(
      'SELECT "scope", "version" FROM "bounda_migrations" ORDER BY "scope", "version"',
    );
    client.close();
    expect(rows.map((row) => [row.scope, Number(row.version)])).toEqual([
      ["checkpoints", 1],
      ["checkpoints", 2],
      ["checkpoints", 3],
      ["storage", 1],
      ["storage", 2],
      ["storage", 3],
      ["storage", 4],
      ["storage", 5],
    ]);
  });

  it("creates the directory of a file that does not exist yet", async () => {
    const adapter = sqlite({ path: join(directory, "nested", "deeper", "app.db") });
    const storage = await adapter.createStorage();
    expect(await storage.eventStore.lastPosition()).toBe(0);
    await storage.close();
  });

  it("keeps data across adapters pointing at the same file and prefixes tables", async () => {
    const path = freshPath();
    const first = await openStorage(sqlite({ path, tablePrefix: "app_" }));
    await first.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1 })],
    });
    await first.close();

    const second = await openStorage(sqlite({ path, tablePrefix: "app_" }));
    expect(await second.eventStore.lastPosition()).toBe(1);
    const readModel = await sqlite({ path, tablePrefix: "app_" }).createReadModel({
      name: "orderSummary",
      fields: contractFields,
      logger: silentLogger,
    });
    const tables = await (readModel.client.raw as Client).execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'app_%' ORDER BY name",
    );
    expect(tables.rows.map((row) => row.name)).toEqual([
      "app_checkpoints",
      "app_dead_letters",
      "app_events",
      "app_idempotency_keys",
      "app_inbox",
      "app_index_keys",
      "app_migrations",
      "app_person_rows",
      "app_personal_keys",
      "app_persons",
      "app_restricted_persons",
      "app_restricted_positions",
      "app_restrictions",
      "app_rm_order_summary",
      "app_scheduled_commands",
      "app_snapshots",
      "app_subscriber_failures",
    ]);
    await readModel.close();
    await second.close();
  });

  it("logs the lifecycle of a rebuild with the tables involved", async () => {
    const path = freshPath();
    const logs: unknown[] = [];
    const logger = {
      ...silentLogger,
      info: (message: string, fields?: unknown) => {
        logs.push([message, fields]);
      },
    };
    const adapter = sqlite({ path });
    const args = { name: "orderSummary", fields: contractFields, logger, progress: "rebuild:1" };
    const committed = await adapter.rebuildReadModel(args);
    await committed.commit({ subscriber: "projection:orderSummary", position: 0 });
    const aborted = await adapter.rebuildReadModel(args);
    await aborted.abort();
    const table = "bounda_rm_order_summary";
    const shadow = `${table}__rebuild`;
    expect(logs).toEqual([
      ["read model rebuild started", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild committed", { readModel: "orderSummary", table }],
      ["read model rebuild started", { readModel: "orderSummary", table, shadow }],
      ["read model rebuild aborted", { readModel: "orderSummary", table }],
    ]);
    const ports = await adapter.createReadModel({ ...args, logger: silentLogger });
    const tables = await (ports.client.raw as Client).execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bounda_rm_order%' ORDER BY name",
    );
    expect(tables.rows.map((row) => row.name)).toEqual([table]);
    await ports.close();
  });

  it("evolves a read model table additively and refuses destructive changes", async () => {
    const path = freshPath();
    const logs: unknown[] = [];
    const logger = {
      ...silentLogger,
      info: (message: string, fields?: unknown) => {
        logs.push([message, fields]);
      },
    };
    const v1 = { id: f.string().primaryKey(), total: f.number() };
    const first = await sqlite({ path }).createReadModel<{ id: string; total: number }>({
      name: "orders",
      fields: v1,
      logger,
    });
    await first.table.insert({ id: "o-1", total: 5 });
    await first.close();
    expect(logs).toEqual([]);

    const v2 = { ...v1, note: f.string().optional(), paid: f.boolean().index() };
    const second = await sqlite({ path }).createReadModel<{
      id: string;
      total: number;
      note?: string;
      paid: boolean;
    }>({ name: "orders", fields: v2, logger });
    expect(logs).toEqual([
      ["read model table evolved", { readModel: "orders", table: "bounda_rm_orders", added: 3 }],
    ]);
    const unchanged = await sqlite({ path }).createReadModel({
      name: "orders",
      fields: v2,
      logger,
    });
    await unchanged.close();
    expect(logs).toHaveLength(1);
    expect(await second.table.findOne({ id: "o-1" })).toEqual({ id: "o-1", total: 5 });
    await second.table.upsert({ id: "o-1", total: 5, paid: true, note: "hi" });
    expect(await second.table.findOne({ id: "o-1" })).toEqual({
      id: "o-1",
      total: 5,
      paid: true,
      note: "hi",
    });
    await second.close();

    await expect(
      sqlite({ path }).createReadModel({
        name: "orders",
        fields: { id: f.string().primaryKey() },
        logger: silentLogger,
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      sqlite({ path }).createReadModel({
        name: "orders",
        fields: { ...v2, total: f.string() },
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Changing a field's type needs a rebuild: run `bounda rebuild orders`/);
  });
});

describe("sqlite storage details", () => {
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
    ).toEqual({
      events: [],
      version: 3,
    });
    expect(
      await eventStore.load({ aggregateType: "order", aggregateId: "1", fromVersion: 2 }),
    ).toMatchObject({
      version: 3,
    });
  });

  it("leaves lastError out of a claim that never failed", async () => {
    const { inboxLedger } = await openStorage();
    const key = { handler: "order.p", eventId: "e-1" };
    await inboxLedger.tryClaim({ ...key, now: new Date(), leaseMs: 1_000 });
    expect(await inboxLedger.get(key)).not.toHaveProperty("lastError");
    await inboxLedger.fail({ ...key, error: "boom" });
    expect(await inboxLedger.get(key)).toMatchObject({ lastError: "boom" });
  });
});

describe("sqlite adapter connection sharing", () => {
  it("shares one in-memory database between storage and read models until the last close", async () => {
    const adapter = sqlite({ memory: true });
    const storage = await openStorage(adapter);
    const readModel = await adapter.createReadModel({
      name: "orderSummary",
      fields: contractFields,
      logger: silentLogger,
    });
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1 })],
    });
    const seen = await (readModel.client.raw as Client).execute(
      "SELECT COUNT(*) AS n FROM bounda_events",
    );
    expect(Number(seen.rows[0]?.n)).toBe(1);

    await storage.close();
    const stillOpen = await adapter.createStorage();
    expect(await stillOpen.eventStore.lastPosition()).toBe(1);
    await stillOpen.close();
    const client = readModel.client.raw as Client;
    expect(client.closed).toBe(false);
    await readModel.close();
    expect(client.closed).toBe(true);
    await readModel.close();

    const fresh = await adapter.createStorage();
    expect(await fresh.eventStore.lastPosition()).toBe(0);
    await fresh.close();
  });
});

describe("resolveSqliteOptions", () => {
  it("maps every location to a libSQL url and applies the default prefix", () => {
    expect(resolveSqliteOptions({ memory: true })).toEqual({
      url: ":memory:",
      tablePrefix: "bounda_",
      location: "memory",
    });
    expect(resolveSqliteOptions({ path: "./data/app.db", tablePrefix: "x_" })).toEqual({
      url: "file:./data/app.db",
      tablePrefix: "x_",
      location: "file",
    });
    expect(resolveSqliteOptions({ url: "libsql://db.turso.io", authToken: "t" })).toEqual({
      url: "libsql://db.turso.io",
      authToken: "t",
      tablePrefix: "bounda_",
      location: "remote",
    });
    expect(resolveSqliteOptions({ url: "file:./app.db" })).toMatchObject({ location: "file" });
    expect(resolveSqliteOptions({ url: ":memory:" })).toMatchObject({ location: "memory" });
    expect(resolveSqliteOptions({ url: "file::memory:?cache=shared" })).toMatchObject({
      location: "memory",
    });
    expect(resolveSqliteOptions({ url: "libsql://db.turso.io" })).not.toHaveProperty("authToken");
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
          evolve: ({ state }: { state: OrderState }) => ({ ...state, status: "placed" as const }),
        },
        orderPaid: {
          evolve: ({ state }: { state: OrderState }) => ({ ...state, status: "paid" as const }),
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
          module: {
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
        order: {
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
              "SELECT order_id, status, total FROM bounda_rm_order_summary WHERE order_id = ?",
              [orderId],
            ),
          handler: ({ repositoryData }: { repositoryData: Row | null }) => repositoryData,
        },
      },
    },
  },
} as const satisfies Registry;

describe("an app on the sqlite adapter", () => {
  it("runs commands, policies, projections, scheduled commands and SQL queries end to end", async () => {
    const { app, clock } = await createTestApp({ registry, adapter: sqlite({ memory: true }) });
    await app.commands.placeOrder({ orderId: "o-1", total: 42 });
    await app.commands.placeOrder({ orderId: "o-2", total: 7 }, { delay: "1h" });
    await app.runUntilIdle();
    expect(await app.queries.getOrder({ orderId: "o-1" })).toEqual({
      orderId: "o-1",
      status: "paid",
      total: 42,
    });
    expect(await app.queries.getOrder({ orderId: "o-2" })).toBeNull();

    clock.advance(3_600_000);
    await app.runUntilIdle();
    expect(await app.queries.getOrder({ orderId: "o-2" })).toMatchObject({ status: "paid" });
    expect((await app.getLag()).maxLag).toBe(0);
    await app.stop();
  });
});
