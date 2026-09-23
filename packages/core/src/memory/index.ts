import type {
  Adapter,
  CreateReadModelArgs,
  CreateReadModelRebuildArgs,
  StoragePorts,
} from "../adapter/adapter.ts";
import type { Table } from "../adapter/ports/table.ts";
import type { FieldsRecord } from "../modules/view.ts";
import { createMemoryCheckpointStore } from "./checkpoint-store.ts";
import { createMemoryDeadLetterStore } from "./dead-letter-store.ts";
import { createMemoryEventNotifier } from "./event-notifier.ts";
import { createMemoryEventStore } from "./event-store.ts";
import { createMemoryInboxLedger } from "./inbox-ledger.ts";
import { createMemoryScheduler } from "./scheduler.ts";
import { createMemoryReadClient, createMemoryTable } from "./table.ts";

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
  current: Table<Record<string, unknown>>;
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
 */
export const memory: MemoryFunction = (options = {}) => {
  let storage: StoragePorts | null = null;
  const tables = new Map<string, LiveTable>();
  const shadows = new Map<string, Table<Record<string, unknown>>>();

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
        checkpointStore: createMemoryCheckpointStore(),
        inboxLedger: createMemoryInboxLedger(),
        deadLetterStore: createMemoryDeadLetterStore(),
        scheduler: createMemoryScheduler(),
        close: async () => {},
      };
      return storage;
    },
    createReadModel: async <Row extends object>({ name, fields }: CreateReadModelArgs) => {
      const table = through<Row>(live(name, fields));
      return { table, client: createMemoryReadClient({ name, table }), close: async () => {} };
    },
    rebuildReadModel: async <Row extends object>({
      name,
      fields,
      resume = false,
    }: CreateReadModelRebuildArgs) => {
      const left = resume ? shadows.get(name) : undefined;
      const shadow = (left as Table<Row> | undefined) ?? createMemoryTable<Row>({ name, fields });
      shadows.set(name, shadow as unknown as Table<Record<string, unknown>>);
      return {
        table: shadow,
        client: createMemoryReadClient({ name, table: shadow }),
        resumed: left !== undefined,
        commit: async () => {
          shadows.delete(name);
          const target = tables.get(name);
          if (target === undefined) {
            tables.set(name, { current: shadow as unknown as Table<Record<string, unknown>> });
          } else {
            target.current = shadow as unknown as Table<Record<string, unknown>>;
          }
        },
        abort: async () => {
          shadows.delete(name);
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
export type { CreateMemoryTableArgs } from "./table.ts";
export { createMemoryReadClient, createMemoryTable } from "./table.ts";
