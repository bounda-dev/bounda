import type {
  Adapter,
  CreateReadModelArgs,
  CreateReadModelRebuildArgs,
  ReadModelRebuild,
  ReadModelStorage,
  Storage,
} from "../adapter/adapter.ts";
import { type DataLocationOptions, placementOf } from "../adapter/adapter-definition.ts";
import { rebuildFencing } from "../adapter/rebuild-fencing.ts";
import { DEFAULT_TABLE_PREFIX, tableNameFor } from "../adapter/sql/identifiers.ts";
import { rebuildTablesFor } from "../adapter/sql/read-model-schema.ts";
import type { CheckpointStore } from "../adapter/storage/checkpoint-store.ts";
import { type InspectedTable, opaqueColumnsOf } from "../adapter/storage/inspection.ts";
import type { StoredRestriction } from "../adapter/storage/person-store.ts";
import {
  isLeftOut,
  isRetainedKey,
  type RestrictedReads,
  type RestrictionView,
  restrictedFieldsOf,
} from "../adapter/storage/restricted-persons.ts";
import type { Table } from "../adapter/storage/table.ts";
import { RebuildSupersededError } from "../contracts/errors.ts";
import { createEphemeralKeys } from "../kernel/personal-data/ephemeral-keys.ts";
import type { FieldsRecord } from "../modules/view.ts";
import { createMemoryCheckpointStore } from "./checkpoint-store.ts";
import { createKeptDeadLetterStore } from "./dead-letter-store.ts";
import { createMemoryEventNotifier } from "./event-notifier.ts";
import { createMemoryEventStore } from "./event-store.ts";
import { createMemoryForgetLedgers } from "./forget-ledger.ts";
import { createKeptIdempotencyStore } from "./idempotency-store.ts";
import { createKeptInboxLedger } from "./inbox-ledger.ts";
import { createMemoryIndexKeyStore } from "./index-key-store.ts";
import { byKey, entriesRows, storageTable } from "./inspection.ts";
import { createKeptPersonStore } from "./person-store.ts";
import { createKeptPersonalKeyStore } from "./personal-key-store.ts";
import { createKeptRecipientStore } from "./recipient-store.ts";
import { createMemoryRestrictedPersons } from "./restricted-persons.ts";
import { createKeptScheduler } from "./scheduler.ts";
import { createMemorySnapshotStore } from "./snapshot-store.ts";
import { createMemorySubscriberFailureStore } from "./subscriber-failure-store.ts";
import { createMemoryReadClient, createMemoryTable, type MemoryTable, runsNoSql } from "./table.ts";
import { createMemoryTenancyStore } from "./tenancy-store.ts";
import { createMemoryTenantFence, FENCED_WRITES } from "./tenant-fence.ts";
import { createMemoryTenantKeyStore } from "./tenant-key-store.ts";
import {
  createCheckpointJournal,
  createMemoryLocks,
  createMemoryStorageTransaction,
} from "./transaction.ts";

/**
 * Options of `memory()`: where the process that holds the data runs.
 */
export type MemoryOptions = DataLocationOptions;

/**
 * The adapter `memory()` returns: what `bounda.config.ts` holds under `storage` or `readModels`.
 */
export type MemoryAdapter = Adapter<"memory", MemoryOptions>;

export interface MemoryFunction {
  (options?: MemoryOptions): MemoryAdapter;
}

interface LiveTable {
  current: MemoryTable<Record<string, unknown>>;
}

const readModelTable = (
  name: string,
  table: MemoryTable<Record<string, unknown>>,
  shadow = false,
): InspectedTable => {
  const live = tableNameFor({ prefix: DEFAULT_TABLE_PREFIX, readModel: name });
  const rows = byKey(table.rows(), [table.key]);
  return {
    name: shadow ? rebuildTablesFor(live).shadow : live,
    store: "readModel",
    key: [table.key],
    opaque: opaqueColumnsOf("readModel", Object.keys(rows[0] ?? {})),
    rows,
  };
};

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
 * The in-memory storage adapter: every store backed by maps, gone when the process ends. For
 * tests and for trying Bounda without a database. Each call returns an adapter with its own
 * isolated storage, shared by everything opened from that adapter, as a database would be. It
 * notifies the dispatcher of appends, so a started app reacts without waiting for a poll.
 */
export const memory: MemoryFunction = (options = {}) => {
  let storage: Storage | null = null;
  // One database: the storage and every read model behind one fence.
  const fence = createMemoryTenantFence();
  const checkpoints = createMemoryCheckpointStore();
  const checkpointStore = fence.guard(checkpoints, FENCED_WRITES.checkpointStore);
  const locks = createMemoryLocks();
  const tables = new Map<string, LiveTable>();
  const shadows = new Map<string, MemoryTable<Record<string, unknown>>>();
  const forgetLedgers = createMemoryForgetLedgers();
  const tenantKeys = createMemoryTenantKeyStore();
  const ephemeral = createEphemeralKeys(tenantKeys);
  const restrictedPersons = createMemoryRestrictedPersons();
  // What `createStorage` opened, read by `inspect`.
  let storageTables: () => readonly InspectedTable[] = () => [];

  const inTransaction = async <T>(
    target: MemoryTable<Record<string, unknown>>,
    work: (store: CheckpointStore) => Promise<T>,
  ): Promise<T> => {
    const restore = target.snapshot();
    const restoreRestricted = restrictedPersons.snapshot();
    const journal = createCheckpointJournal(checkpoints);
    try {
      return await work(journal.store);
    } catch (error) {
      restore();
      restoreRestricted();
      await journal.undo();
      throw error;
    }
  };

  // Each read asks the table live then, so a rebuild that swapped it is read.
  const restrictedReads = <Row extends object>(
    name: string,
    target: LiveTable,
    fields: FieldsRecord,
  ): RestrictedReads<Row> => {
    const restricted = restrictedFieldsOf(fields);
    const leftOut = (person: unknown, view: RestrictionView): boolean =>
      restricted !== null &&
      typeof person === "string" &&
      isLeftOut({
        restrictions: restrictedPersons.restrictionsOf(person),
        categories: restricted.categories,
        view,
      });
    const retained = (row: Readonly<Record<string, unknown>>): boolean =>
      (restricted?.keyFields ?? []).some((field) => isRetainedKey(row[field]));
    const keeping = (view: RestrictionView): Table<Row> => {
      const current = (): Table<Row> =>
        target.current.keeping(
          (row) =>
            restricted === null ||
            (!leftOut(row[restricted.person], view) && (view !== "unrestricted" || !retained(row))),
        ) as unknown as Table<Row>;
      return {
        ...fence.guard(through<Row>(target), FENCED_WRITES.table),
        findOne: (where) => current().findOne(where),
        findMany: (args) => current().findMany(args),
        count: (where) => current().count(where),
      };
    };
    return {
      unrestricted: keeping("unrestricted"),
      retained: keeping("retained"),
      condition: () => {
        throw runsNoSql(name);
      },
      among: async (persons, view) => new Set(persons.filter((person) => leftOut(person, view))),
    };
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
    ...placementOf(options),
    // Nothing to version: the stores live in this process alone.
    schemaVersions: async () => [],
    migrate: async () => [],
    createStorage: async () => {
      const notifier = createMemoryEventNotifier();
      const inboxLedger = createKeptInboxLedger();
      const scheduler = createKeptScheduler();
      const persons = createKeptPersonStore();
      const deadLetterStore = createKeptDeadLetterStore({
        restricted: (person) => persons.restrictionsOf(person).length > 0,
      });
      const personalKeys = createKeptPersonalKeyStore({
        restricted: persons.restricted,
        lastActiveAt: persons.lastActiveAt,
      });
      const idempotencyStore = createKeptIdempotencyStore({ holds: personalKeys.holds });
      const snapshotStore = createMemorySnapshotStore({ holds: personalKeys.holds });
      const subscriberFailures = createMemorySubscriberFailureStore({
        restricted: (person) => persons.restrictionsOf(person).length > 0,
      });
      const indexKeys = createMemoryIndexKeyStore();
      const tenancy = createMemoryTenancyStore();
      const recipients = createKeptRecipientStore();
      const stores = {
        eventStore: createMemoryEventStore({
          onAppend: notifier.notify,
          checks: { keyOf: personalKeys.keyOf, restrictionsOf: persons.restrictionsOf },
        }),
        inboxLedger: inboxLedger.store,
        deadLetterStore: deadLetterStore.store,
        scheduler: scheduler.store,
        idempotencyStore: idempotencyStore.store,
        personalKeys: personalKeys.store,
        persons: persons.store,
        recipients: recipients.store,
        snapshotStore,
      };
      if (storage === null) {
        storageTables = () => [
          storageTable({ table: "events", key: ["position"], rows: stores.eventStore.rows() }),
          storageTable({
            table: "snapshots",
            key: ["aggregateType", "aggregateId"],
            rows: snapshotStore.rows(),
          }),
          storageTable({
            table: "subscriberFailures",
            key: ["subscriber"],
            rows: subscriberFailures.rows(),
          }),
          storageTable({
            table: "inbox",
            key: ["handler", "eventId"],
            rows: entriesRows(inboxLedger.entries),
          }),
          storageTable({
            table: "deadLetters",
            key: ["id"],
            rows: entriesRows(deadLetterStore.entries),
          }),
          storageTable({
            table: "scheduledCommands",
            key: ["dedupeKey"],
            rows: entriesRows(scheduler.entries),
          }),
          storageTable({
            table: "idempotencyKeys",
            key: ["key"],
            rows: entriesRows(idempotencyStore.entries),
          }),
          storageTable({ table: "personalKeys", key: ["person"], rows: personalKeys.keyRows() }),
          storageTable({
            table: "supersededKeys",
            key: ["person", "fingerprint"],
            rows: personalKeys.supersededRows(),
          }),
          storageTable({ table: "indexKeys", key: ["scope"], rows: indexKeys.rows() }),
          storageTable({ table: "tenancy", key: ["scope"], rows: tenancy.rows() }),
          storageTable({
            table: "disclosures",
            key: ["person", "port", "recipient", "category"],
            rows: recipients.disclosureRows(),
          }),
          storageTable({ table: "recipients", key: ["port"], rows: recipients.recipientRows() }),
          storageTable({
            table: "persons",
            key: ["person"],
            rows: entriesRows(persons.entries).map(({ restrictions: _, ...row }) => row),
          }),
          storageTable({
            table: "restrictions",
            key: ["person", "ground", "category"],
            rows: entriesRows(persons.entries).flatMap((row) =>
              (row.restrictions as readonly StoredRestriction[]).map(
                ({ ground, category, since }) => ({
                  person: row.person,
                  ground,
                  category: category ?? "",
                  since,
                }),
              ),
            ),
          }),
        ];
      }
      const raw = {
        ...stores,
        notifier,
        checkpointStore: checkpoints,
        snapshotStore,
        subscriberFailures,
        indexKeys,
      };
      const transact = createMemoryStorageTransaction({
        ...stores,
        recipients,
        entries: {
          inboxLedger: inboxLedger.entries,
          deadLetterStore: deadLetterStore.entries,
          scheduler: scheduler.entries,
          idempotencyStore: idempotencyStore.entries,
          personalKeys: personalKeys.entries,
          persons: persons.entries,
        },
      });
      const behind = (pass?: "forgotten"): Storage => ({
        eventStore: fence.guard(raw.eventStore, FENCED_WRITES.eventStore, pass),
        inboxLedger: fence.guard(raw.inboxLedger, FENCED_WRITES.inboxLedger, pass),
        deadLetterStore: fence.guard(raw.deadLetterStore, FENCED_WRITES.deadLetterStore, pass),
        scheduler: fence.guard(raw.scheduler, FENCED_WRITES.scheduler, pass),
        idempotencyStore: fence.guard(raw.idempotencyStore, FENCED_WRITES.idempotencyStore, pass),
        personalKeys: fence.guard(raw.personalKeys, FENCED_WRITES.personalKeys, pass),
        persons: fence.guard(raw.persons, FENCED_WRITES.persons, pass),
        recipients: fence.guard(raw.recipients, FENCED_WRITES.recipients, pass),
        snapshotStore: fence.guard(raw.snapshotStore, FENCED_WRITES.snapshotStore, pass),
        subscriberFailures: fence.guard(
          raw.subscriberFailures,
          FENCED_WRITES.subscriberFailures,
          pass,
        ),
        indexKeys: fence.guard(raw.indexKeys, FENCED_WRITES.indexKeys, pass),
        checkpointStore: fence.guard(raw.checkpointStore, FENCED_WRITES.checkpointStore, pass),
        notifier,
        tenancy,
        fence: fence.store,
        forgotten: () => behind("forgotten"),
        transact: (work) => fence.write(() => transact(work), pass),
        close: async () => {},
      });
      storage ??= behind();
      return storage;
    },
    createReadModel: async <Row extends object>({
      name,
      fields,
    }: CreateReadModelArgs): Promise<ReadModelStorage<Row>> => {
      const target = live(name, fields);
      const table = through<Row>(target);
      const client = createMemoryReadClient({ name, table });
      const guarded = fence.guard(table, FENCED_WRITES.table);
      return {
        table: guarded,
        client: createMemoryReadClient({ name, table: guarded }),
        restricted: restrictedReads<Row>(name, target, fields),
        checkpointStore,
        fence: fence.store,
        transact: async ({ subscriber, wait, work, forgotten = false }) => {
          const release = await locks.acquire(subscriber, wait);
          if (release === undefined) return { acquired: false };
          try {
            return {
              acquired: true,
              value: await fence.write(
                () =>
                  inTransaction(target.current, (store) =>
                    work({
                      table,
                      client,
                      checkpointStore: store,
                      restrictedPersons: restrictedPersons.store,
                      unsettled: (args) =>
                        target.current.unsettled(args) as Promise<readonly Row[]>,
                    }),
                  ),
                forgotten ? "forgotten" : undefined,
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
      // Every step writes the read model's rows, the shadow's included.
      const fenced = <T>(work: () => Promise<T>): Promise<T> =>
        holding(fencing.lock, () =>
          fence.write(async () => {
            if (!(await current())) throw new RebuildSupersededError(name);
            return work();
          }),
        );
      const table = shadow as unknown as MemoryTable<Row>;
      const client = createMemoryReadClient({ name, table });
      return {
        table: fence.guard(table, FENCED_WRITES.table),
        client,
        resumed: opened.resumed,
        position: opened.position,
        checkpointStore,
        transact: (work) =>
          fenced(() =>
            inTransaction(shadow, (store) =>
              work({
                table,
                client,
                checkpointStore: store,
                restrictedPersons: restrictedPersons.store,
                unsettled: (args) => shadow.unsettled(args) as Promise<readonly Row[]>,
              }),
            ),
          ),
        commit: ({ subscriber, position, marks = {} }) =>
          holding(subscriber, () =>
            fenced(async () => {
              shadows.delete(name);
              const target = tables.get(name);
              if (target === undefined) tables.set(name, { current: shadow });
              else target.current = shadow;
              await checkpoints.set(subscriber, position);
              for (const [mark, value] of Object.entries(marks)) {
                await checkpoints.set(mark, value);
              }
              await checkpoints.remove(progress);
            }),
          ),
        abort: () =>
          holding(fencing.lock, () =>
            fence.write(async () => {
              if (!(await current())) return;
              shadows.delete(name);
              await checkpoints.remove(progress);
            }),
          ),
        pause: async () => {},
      };
    },
    createForgetLedger: async ({ tenant }) => forgetLedgers.ledgerOf(tenant),
    createTenantKeyStore: async () => tenantKeys,
    ephemeralKeys: ephemeral,
    inspect: async () => [
      ...storageTables(),
      storageTable({ table: "checkpoints", key: ["subscriber"], rows: checkpoints.rows() }),
      storageTable({ table: "tenantFence", key: ["scope"], rows: fence.rows() }),
      storageTable({
        table: "restrictedPersons",
        key: ["person", "source", "category"],
        rows: restrictedPersons
          .rows()
          .map(({ person, source, category }) => ({ person, source, category: category ?? "" })),
      }),
      storageTable({
        table: "restrictedPositions",
        key: ["person"],
        rows: restrictedPersons.positions(),
      }),
      storageTable({
        table: "forgetLedger",
        key: ["tenant", "eventId"],
        rows: forgetLedgers.rows(),
      }),
      storageTable({ table: "tenantKeys", key: ["tenant"], rows: tenantKeys.rows() }),
      ...[...tables.entries()].map(([name, { current }]) => readModelTable(name, current)),
      ...[...shadows.entries()].map(([name, shadow]) => readModelTable(name, shadow, true)),
    ],
  };
};
