import type {
  Adapter,
  CreateReadModelArgs,
  CreateReadModelRebuildArgs,
  ReadModelPorts,
  ReadModelRebuild,
  StoragePorts,
} from "../adapter/adapter.ts";
import type { CheckpointStore } from "../adapter/ports/checkpoint-store.ts";
import type { Table } from "../adapter/ports/table.ts";
import type { FieldsRecord } from "../modules/view.ts";
import { createMemoryCheckpointStore } from "./checkpoint-store.ts";
import { createMemoryDeadLetterStore } from "./dead-letter-store.ts";
import { createMemoryEventNotifier } from "./event-notifier.ts";
import { createMemoryEventStore } from "./event-store.ts";
import { createMemoryInboxLedger } from "./inbox-ledger.ts";
import { createMemoryScheduler } from "./scheduler.ts";
import { createMemoryReadClient, createMemoryTable, type MemoryTable } from "./table.ts";
import { createCheckpointJournal, createMemoryLocks } from "./transaction.ts";

/**
 * Options of the in-memory adapter. It has none; the object exists so the factory reads like the
 * others.
 */
export type MemoryOptions = Record<never, never>;

export type MemoryAdapter = Adapter<"memory", MemoryOptions>;

export interface MemoryFunction {
  (options?: MemoryOptions): MemoryAdapter;
}

interface LiveTable {
  current: MemoryTable<Record<string, unknown>>;
}

const through = <Row extends object>(live: LiveTable): Table<Row> => {
  const table = (): Table<Row> => live.current as unknown as Table<Row>;
  return {
    upsert: (row) => table().upsert(row),
    insert: (row) => table().insert(row),
    update: (where, patch) => table().update(where, patch),
    delete: (where) => table().delete(where),
    findOne: (where) => table().findOne(where),
    findMany: (args) => table().findMany(args),
    count: (where) => table().count(where),
  };
};

/**
 * The in-memory storage adapter: every port backed by maps, gone when the process ends. For
 * tests and for trying Bounda without a database. Each call returns an adapter with its own
 * isolated storage, shared by everything opened from that adapter, as a database would be. It
 * notifies the dispatcher of appends, so a started app reacts without waiting for a poll.
 * `transact` holds a named lock for the work and, when it throws, puts the read model's rows and
 * the checkpoints it changed back as they were.
 */
export const memory: MemoryFunction = (options = {}) => {
  let storage: StoragePorts | null = null;
  const checkpointStore = createMemoryCheckpointStore();
  const locks = createMemoryLocks();
  const tables = new Map<string, LiveTable>();
  const shadows = new Map<string, MemoryTable<Record<string, unknown>>>();

  const inTransaction = async <T>(
    target: MemoryTable<Record<string, unknown>>,
    work: (store: CheckpointStore) => Promise<T>,
  ): Promise<T> => {
    const restore = target.snapshot();
    const journal = createCheckpointJournal(checkpointStore);
    try {
      return await work(journal.store);
    } catch (error) {
      restore();
      await journal.undo();
      throw error;
    }
  };

  const live = (name: string, fields: FieldsRecord): LiveTable => {
    const existing = tables.get(name);
    if (existing !== undefined) return existing;
    const created: LiveTable = { current: createMemoryTable({ name, fields }) };
    tables.set(name, created);
    return created;
  };

  return {
    kind: "bounda-adapter",
    name: "memory",
    options,
    createStorage: async () => {
      const notifier = createMemoryEventNotifier();
      storage ??= {
        eventStore: createMemoryEventStore({ onAppend: notifier.notify }),
        notifier,
        checkpointStore,
        inboxLedger: createMemoryInboxLedger(),
        deadLetterStore: createMemoryDeadLetterStore(),
        scheduler: createMemoryScheduler(),
        close: async () => {},
      };
      return storage;
    },
    createReadModel: async <Row extends object>({
      name,
      fields,
    }: CreateReadModelArgs): Promise<ReadModelPorts<Row>> => {
      const target = live(name, fields);
      const table = through<Row>(target);
      const client = createMemoryReadClient({ name, table });
      return {
        table,
        client,
        checkpointStore,
        transact: async ({ subscriber, wait, work }) => {
          const release = await locks.acquire(subscriber, wait);
          if (release === undefined) return { acquired: false };
          try {
            return {
              acquired: true,
              value: await inTransaction(target.current, (store) =>
                work({ table, client, checkpointStore: store }),
              ),
            };
          } finally {
            release();
          }
        },
        close: async () => {},
      };
    },
    rebuildReadModel: async <Row extends object>({
      name,
      fields,
      progress,
    }: CreateReadModelRebuildArgs): Promise<ReadModelRebuild<Row>> => {
      const saved = await checkpointStore.get(progress);
      const left = saved > 0 ? shadows.get(name) : undefined;
      if (left === undefined) await checkpointStore.remove(progress);
      const shadow = left ?? createMemoryTable({ name, fields });
      shadows.set(name, shadow);
      const table = shadow as unknown as MemoryTable<Row>;
      const client = createMemoryReadClient({ name, table });
      return {
        table,
        client,
        resumed: left !== undefined,
        position: left === undefined ? 0 : saved,
        checkpointStore,
        transact: (work) =>
          inTransaction(shadow, (store) => work({ table, client, checkpointStore: store })),
        commit: async ({ subscriber, position }) => {
          const release = await locks.acquire(subscriber, true);
          try {
            shadows.delete(name);
            const target = tables.get(name);
            if (target === undefined) tables.set(name, { current: shadow });
            else target.current = shadow;
            await checkpointStore.set(subscriber, position);
            await checkpointStore.remove(progress);
          } finally {
            release?.();
          }
        },
        abort: async () => {
          shadows.delete(name);
          await checkpointStore.remove(progress);
        },
        pause: async () => {},
      };
    },
  };
};

export { createMemoryCheckpointStore } from "./checkpoint-store.ts";
export { createMemoryDeadLetterStore } from "./dead-letter-store.ts";
export type { CreateMemoryEventNotifierFunction, MemoryEventNotifier } from "./event-notifier.ts";
export { createMemoryEventNotifier } from "./event-notifier.ts";
export type { CreateMemoryEventStoreArgs } from "./event-store.ts";
export { createMemoryEventStore } from "./event-store.ts";
export { createMemoryInboxLedger } from "./inbox-ledger.ts";
export { createMemoryScheduler } from "./scheduler.ts";
export type { CreateMemoryTableArgs, MemoryTable } from "./table.ts";
export { createMemoryReadClient, createMemoryTable } from "./table.ts";
