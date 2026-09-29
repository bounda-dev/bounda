import type {
  Adapter,
  CreateReadModelArgs,
  CreateReadModelRebuildArgs,
  ReadModelPorts,
  ReadModelRebuild,
  StoragePorts,
} from "../adapter/adapter.ts";
import type { CheckpointStore } from "../adapter/ports/checkpoint-store.ts";
import type { DeadLetterStore } from "../adapter/ports/dead-letter-store.ts";
import type { InboxLedger } from "../adapter/ports/inbox-ledger.ts";
import type { Scheduler } from "../adapter/ports/scheduler.ts";
import type { Table } from "../adapter/ports/table.ts";
import { rebuildFencing } from "../adapter/rebuild-fencing.ts";
import { createStagedEventStore } from "../adapter/staged-event-store.ts";
import { RebuildSupersededError } from "../contracts/errors.ts";
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
      const eventStore = createMemoryEventStore({ onAppend: notifier.notify });
      const inboxLedger = createMemoryInboxLedger();
      const deadLetterStore = createMemoryDeadLetterStore();
      const scheduler = createMemoryScheduler();
      storage ??= {
        eventStore,
        notifier,
        checkpointStore,
        inboxLedger,
        deadLetterStore,
        scheduler,
        // Appends are staged and the other writes deferred while the work runs; once it resolves,
        // every version is checked and every write applied in one synchronous run, so nothing
        // observes a half-applied transaction. A write that fails partway puts every store back
        // from its snapshot. `tryClaim` and `claimDue` answer at once, outside the transaction.
        transact: async (work) => {
          const staged = createStagedEventStore(eventStore);
          const deferred: (() => Promise<unknown>)[] = [];
          const later =
            <Args extends unknown[]>(write: (...args: Args) => Promise<unknown>) =>
            async (...args: Args): Promise<void> => {
              deferred.push(() => write(...args));
            };
          const ledger: InboxLedger = {
            tryClaim: inboxLedger.tryClaim,
            get: inboxLedger.get,
            complete: later(inboxLedger.complete),
            fail: later(inboxLedger.fail),
          };
          const letters: DeadLetterStore = {
            get: deadLetterStore.get,
            list: deadLetterStore.list,
            count: deadLetterStore.count,
            add: async (letter) => {
              deferred.push(() => deadLetterStore.add(letter));
              return { ...letter, status: "failed" };
            },
            updateStatus: later(deadLetterStore.updateStatus),
            remove: later(deadLetterStore.remove),
          };
          const schedule: Scheduler = {
            claimDue: scheduler.claimDue,
            nextDueAt: scheduler.nextDueAt,
            list: scheduler.list,
            schedule: later(scheduler.schedule),
            cancel: later(scheduler.cancel),
            complete: later(scheduler.complete),
            fail: later(scheduler.fail),
            defer: later(scheduler.defer),
          };
          const result = await work({
            eventStore: staged,
            inboxLedger: ledger,
            deadLetterStore: letters,
            scheduler: schedule,
          });
          const restore = [eventStore, inboxLedger, deadLetterStore, scheduler].map((store) =>
            store.snapshot(),
          );
          try {
            const applied = eventStore.appendAll(staged.batches());
            const writes = deferred.map((write) => write());
            await Promise.all([applied, ...writes]);
          } catch (error) {
            for (const undo of restore) undo();
            throw error;
          }
          return result;
        },
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
      const fencing = rebuildFencing(name);
      const holding = async <T>(lock: string, work: () => Promise<T>): Promise<T> => {
        const release = await locks.acquire(lock, true);
        try {
          return await work();
        } finally {
          release?.();
        }
      };
      const opened = await holding(fencing.lock, async () => {
        const generation = (await checkpointStore.get(fencing.generation)) + 1;
        await checkpointStore.set(fencing.generation, generation);
        const saved = await checkpointStore.get(progress);
        const left = saved > 0 ? shadows.get(name) : undefined;
        if (left === undefined) await checkpointStore.remove(progress);
        const shadow = left ?? createMemoryTable({ name, fields });
        shadows.set(name, shadow);
        const resumed = left !== undefined;
        return { generation, shadow, resumed, position: resumed ? saved : 0 };
      });
      const { generation, shadow } = opened;
      const current = async (): Promise<boolean> =>
        (await checkpointStore.get(fencing.generation)) === generation;
      const fenced = <T>(work: () => Promise<T>): Promise<T> =>
        holding(fencing.lock, async () => {
          if (!(await current())) throw new RebuildSupersededError(name);
          return work();
        });
      const table = shadow as unknown as MemoryTable<Row>;
      const client = createMemoryReadClient({ name, table });
      return {
        table,
        client,
        resumed: opened.resumed,
        position: opened.position,
        checkpointStore,
        transact: (work) =>
          fenced(() =>
            inTransaction(shadow, (store) => work({ table, client, checkpointStore: store })),
          ),
        commit: ({ subscriber, position }) =>
          holding(subscriber, () =>
            fenced(async () => {
              shadows.delete(name);
              const target = tables.get(name);
              if (target === undefined) tables.set(name, { current: shadow });
              else target.current = shadow;
              await checkpointStore.set(subscriber, position);
              await checkpointStore.remove(progress);
            }),
          ),
        abort: () =>
          holding(fencing.lock, async () => {
            if (!(await current())) return;
            shadows.delete(name);
            await checkpointStore.remove(progress);
          }),
        pause: async () => {},
      };
    },
  };
};

export { createMemoryCheckpointStore } from "./checkpoint-store.ts";
export type { MemoryDeadLetterStore } from "./dead-letter-store.ts";
export { createMemoryDeadLetterStore } from "./dead-letter-store.ts";
export type { CreateMemoryEventNotifierFunction, MemoryEventNotifier } from "./event-notifier.ts";
export { createMemoryEventNotifier } from "./event-notifier.ts";
export type { CreateMemoryEventStoreArgs, MemoryEventStore } from "./event-store.ts";
export { createMemoryEventStore } from "./event-store.ts";
export type { MemoryInboxLedger } from "./inbox-ledger.ts";
export { createMemoryInboxLedger } from "./inbox-ledger.ts";
export type { MemoryScheduler } from "./scheduler.ts";
export { createMemoryScheduler } from "./scheduler.ts";
export type { CreateMemoryTableArgs, MemoryTable } from "./table.ts";
export { createMemoryReadClient, createMemoryTable } from "./table.ts";
