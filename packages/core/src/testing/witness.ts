import type {
  Adapter,
  ReadModelRebuild,
  ReadModelStorage,
  ReadModelTransaction,
  Storage,
  StorageTransaction,
} from "../adapter/adapter.ts";
import type { PersonalEnvelope, StoredPersonalKey } from "../adapter/storage/personal-key-store.ts";
import type { Table } from "../adapter/storage/table.ts";
import type { LogFields, Logger } from "../contracts/logger.ts";
import { isSealed } from "../kernel/personal-data/crypto.ts";
import type { PersonalDataWitness } from "../kernel/personal-data/witness.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../modules/bounda-events.ts";
import type { FieldsRecord } from "../modules/view.ts";

/**
 * What a log entry was, as the test app's logger received it.
 */
export interface LoggedEntry {
  readonly level: keyof Logger;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/**
 * A value a read model kept in a field marked `.personal()`, and how many times its person had
 * been forgotten when it was written: only what was written before their last forgetting is
 * theirs no longer.
 */
interface KeptValue {
  readonly value: unknown;
  readonly forgettings: number;
}

/**
 * Everything the test apps over one storage saw that `expectForgotten` needs once the person's
 * key is gone: the values sealed under each key, the keys, what the read models kept of each
 * person, and the logs.
 */
export interface TestWitness {
  readonly onPersonalKey: PersonalDataWitness["onPersonalKey"];
  readonly logs: readonly LoggedEntry[];
  /**
   * The envelopes sealed under the person's keys, with the key that opens each when the test app
   * held it.
   */
  sealedFor(person: string): readonly SealedFor[];
  /**
   * What the read models kept in their personal fields of the person, before they were last
   * forgotten.
   */
  keptFor(person: string): readonly unknown[];
  /**
   * `adapter`, observed: the same object for the same adapter, so the app still tells it apart
   * from another, as the forget ledger's check that it is not the storage does.
   */
  storage(adapter: Adapter): Adapter;
  logger(logger: Logger): Logger;
}

export interface SealedFor {
  readonly envelope: PersonalEnvelope;
  readonly key: StoredPersonalKey | null;
}

/**
 * The text of an error, which may quote anything: what its person's values are is found in the
 * fields they came from, and a whole message would match every other letter that failed alike.
 */
const ERROR_TEXT = new Set(["errorMessage", "errorStack"]);

export interface TestWitnessOfFunction {
  (adapter: Adapter): TestWitness;
}

const byAdapter = new WeakMap<Adapter, TestWitness>();

/**
 * The witness of every test app over `adapter`: one that starts again over the same storage, as
 * a test of a restart does, adds to what the earlier one saw, so the values it sealed are still
 * known once the person is forgotten.
 */
export const testWitnessOf: TestWitnessOfFunction = (adapter) => {
  const existing = byAdapter.get(adapter);
  if (existing !== undefined) return existing;
  const created = createTestWitness();
  byAdapter.set(adapter, created);
  return created;
};

const createTestWitness = (): TestWitness => {
  const keys = new Map<string, Map<string, StoredPersonalKey>>();
  const envelopes = new Map<string, Map<string, PersonalEnvelope>>();
  const kept = new Map<string, KeptValue[]>();
  const forgettings = new Map<string, number>();
  const logs: LoggedEntry[] = [];
  const wrapped = new WeakMap<Adapter, Adapter>();

  const observe = (value: unknown, field: string | null, seen: WeakSet<object>): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (isSealed(value)) {
      if (field !== null && ERROR_TEXT.has(field)) return;
      const envelope = value.$personal;
      const sealed = envelopes.get(envelope.person) ?? new Map<string, PersonalEnvelope>();
      sealed.set(envelope.data, envelope);
      envelopes.set(envelope.person, sealed);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) observe(item, field, seen);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      record.type === PERSONAL_DATA_FORGOTTEN_EVENT &&
      record.aggregateType === BOUNDA_AGGREGATE &&
      typeof record.aggregateId === "string"
    ) {
      forgettings.set(record.aggregateId, (forgettings.get(record.aggregateId) ?? 0) + 1);
    }
    for (const [name, inner] of Object.entries(record)) observe(inner, name, seen);
  };
  const observeArgs = (args: readonly unknown[]): void => {
    const seen = new WeakSet<object>();
    for (const arg of args) observe(arg, null, seen);
  };

  // Every call on a store, so a value sealed and then removed, as a cancelled command's, is
  // still known.
  const observed = <T extends object>(store: T): T =>
    new Proxy(store, {
      get: (target, property, receiver) => {
        const member: unknown = Reflect.get(target, property, receiver);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          observeArgs(args);
          return Reflect.apply(member, target, args) as unknown;
        };
      },
    });

  const observedTransaction = (transaction: StorageTransaction): StorageTransaction =>
    Object.fromEntries(
      Object.entries(transaction).map(([name, store]) => [
        name,
        typeof store === "object" && store !== null ? observed(store) : store,
      ]),
    ) as unknown as StorageTransaction;

  const observedStorage = (storage: Storage): Storage => {
    const stores = Object.fromEntries(
      Object.entries(storage).map(([name, member]) => [
        name,
        typeof member === "object" && member !== null ? observed(member) : member,
      ]),
    ) as unknown as Storage;
    return {
      ...stores,
      transact: (work) => storage.transact((transaction) => work(observedTransaction(transaction))),
    };
  };

  const keep = (row: Record<string, unknown>, marks: ReadModelMarks): void => {
    observeArgs([row]);
    const person = marks.person === null ? undefined : row[marks.person];
    if (typeof person !== "string") return;
    const values = kept.get(person) ?? [];
    for (const field of marks.personal) {
      if (row[field] === undefined || row[field] === null) continue;
      values.push({ value: row[field], forgettings: forgettings.get(person) ?? 0 });
    }
    kept.set(person, values);
  };

  const keptBy = <Row extends object>(table: Table<Row>, marks: ReadModelMarks): Table<Row> => ({
    ...table,
    upsert: async (row) => {
      keep(row as Record<string, unknown>, marks);
      await table.upsert(row);
    },
    insert: async (row) => {
      keep(row as Record<string, unknown>, marks);
      await table.insert(row);
    },
    update: async (where, patch) => {
      const changes = patch as Record<string, unknown>;
      if (marks.personal.some((field) => changes[field] !== undefined)) {
        for (const row of await table.findMany({ where })) {
          keep({ ...(row as Record<string, unknown>), ...changes }, marks);
        }
      }
      await table.update(where, patch);
    },
  });

  const keptIn = <Row extends object>(
    transaction: ReadModelTransaction<Row>,
    marks: ReadModelMarks,
  ): ReadModelTransaction<Row> => ({ ...transaction, table: keptBy(transaction.table, marks) });

  const readModelStorage = <Row extends object>(
    storage: ReadModelStorage<Row>,
    marks: ReadModelMarks,
  ): ReadModelStorage<Row> => ({
    ...storage,
    table: keptBy(storage.table, marks),
    transact: (args) =>
      storage.transact({ ...args, work: (transaction) => args.work(keptIn(transaction, marks)) }),
  });

  const readModelRebuild = <Row extends object>(
    rebuild: ReadModelRebuild<Row>,
    marks: ReadModelMarks,
  ): ReadModelRebuild<Row> => ({
    ...rebuild,
    table: keptBy(rebuild.table, marks),
    transact: (work) => rebuild.transact((transaction) => work(keptIn(transaction, marks))),
  });

  const record =
    (level: keyof Logger, logger: Logger) =>
    (message: string, fields?: LogFields): void => {
      logs.push({ level, message, fields });
      logger[level](message, fields);
    };

  return {
    onPersonalKey: (person, key) => {
      const held = keys.get(person) ?? new Map<string, StoredPersonalKey>();
      held.set(key.fingerprint, key);
      keys.set(person, held);
    },
    logs,
    sealedFor: (person) =>
      [...(envelopes.get(person)?.values() ?? [])].map((envelope) => ({
        envelope,
        key: keys.get(person)?.get(envelope.key) ?? null,
      })),
    keptFor: (person) =>
      (kept.get(person) ?? [])
        .filter((value) => value.forgettings < (forgettings.get(person) ?? 0))
        .map(({ value }) => value),
    storage: (adapter) => {
      const existing = wrapped.get(adapter);
      if (existing !== undefined) return existing;
      const observing: Adapter = {
        ...adapter,
        createStorage: async () => observedStorage(await adapter.createStorage()),
        createReadModel: async (args) =>
          readModelStorage(await adapter.createReadModel(args), marksOf(args.fields)),
        rebuildReadModel: async (args) =>
          readModelRebuild(await adapter.rebuildReadModel(args), marksOf(args.fields)),
      };
      wrapped.set(adapter, observing);
      return observing;
    },
    logger: (logger) => ({
      debug: record("debug", logger),
      info: record("info", logger),
      warn: record("warn", logger),
      error: record("error", logger),
    }),
  };
};

interface ReadModelMarks {
  readonly person: string | null;
  readonly personal: readonly string[];
}

const marksOf = (fields: FieldsRecord): ReadModelMarks => {
  const entries = Object.entries(fields);
  return {
    person: entries.find(([, field]) => field.mark === "person")?.[0] ?? null,
    personal: entries.filter(([, field]) => field.mark === "personal").map(([name]) => name),
  };
};
