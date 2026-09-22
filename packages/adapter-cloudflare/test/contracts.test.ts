import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { silentLogger } from "@bounda-dev/core";
import {
  type ContractRow,
  checkpointStoreContract,
  contractFields,
  deadLetterStoreContract,
  eventStoreContract,
  inboxLedgerContract,
  schedulerContract,
  tableContract,
} from "@bounda-dev/core/adapter/testing";
import { describe } from "vitest";
import { createSqliteCheckpointStore } from "../../adapter-sqlite/src/checkpoint-store.ts";
import type { SqliteDatabase } from "../../adapter-sqlite/src/database.ts";
import { createSqliteDeadLetterStore } from "../../adapter-sqlite/src/dead-letter-store.ts";
import { createSqliteEventStore } from "../../adapter-sqlite/src/event-store.ts";
import { createSqliteInboxLedger } from "../../adapter-sqlite/src/inbox-ledger.ts";
import { openSqliteReadModel } from "../../adapter-sqlite/src/read-model.ts";
import { createSqliteScheduler } from "../../adapter-sqlite/src/scheduler.ts";
import { ensureStorageSchema, storageTablesFor } from "../../adapter-sqlite/src/schema.ts";
import { createDurableSqlDatabase } from "../src/sql-database.ts";

const tables = storageTablesFor("bounda_");

type Stub = DurableObjectStub<import("./test-worker.ts").TestStore>;

const freshObject = (): Stub => env.STORE.get(env.STORE.newUniqueId());

const inObject = <T>(stub: Stub, work: (db: SqliteDatabase) => Promise<T>): Promise<T> =>
  runInDurableObject(stub, async (_instance, state) => {
    const db = createDurableSqlDatabase(state.storage) as unknown as SqliteDatabase;
    await ensureStorageSchema({ db, tables });
    return work(db);
  });

const through = <T extends object>(make: (db: SqliteDatabase) => T): T => {
  const stub = freshObject();
  return new Proxy({} as T, {
    get: (_target, key) =>
      key === "then"
        ? undefined
        : (...args: readonly unknown[]) =>
            inObject(stub, async (db) => {
              const method = Reflect.get(make(db), key) as (...args: readonly unknown[]) => unknown;
              return method(...args);
            }),
  });
};

describe("SQLite stores over a Durable Object", () => {
  eventStoreContract({
    create: async () => through((db) => createSqliteEventStore({ db, table: tables.events })),
  });
  checkpointStoreContract({
    create: async () =>
      through((db) => createSqliteCheckpointStore({ db, table: tables.checkpoints })),
  });
  inboxLedgerContract({
    create: async () => through((db) => createSqliteInboxLedger({ db, table: tables.inbox })),
  });
  deadLetterStoreContract({
    create: async () =>
      through((db) => createSqliteDeadLetterStore({ db, table: tables.deadLetters })),
  });
  schedulerContract({
    create: async () =>
      through((db) => createSqliteScheduler({ db, table: tables.scheduledCommands })),
  });
  tableContract({
    create: async () => through((db) => readModelTable(db) as never),
  });
});

const readModelTable = (db: SqliteDatabase) => {
  const pending = openSqliteReadModel<ContractRow>({
    db,
    client: {} as never,
    tablePrefix: "bounda_",
    name: "orderSummary",
    fields: contractFields,
    logger: silentLogger,
    close: async () => {},
  });
  const call =
    (key: string) =>
    async (...args: readonly unknown[]) => {
      const { table } = await pending;
      const method = Reflect.get(table, key) as (...args: readonly unknown[]) => unknown;
      return method(...args);
    };
  return {
    upsert: call("upsert"),
    insert: call("insert"),
    update: call("update"),
    delete: call("delete"),
    findOne: call("findOne"),
    findMany: call("findMany"),
    count: call("count"),
  };
};
