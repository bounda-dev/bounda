import type {
  Adapter,
  ReadModelRebuild,
  ReadModelStorage,
  ReadModelTransaction,
  Storage,
  StorageTransaction,
} from "../adapter/adapter.ts";
import {
  DEFAULT_PERSONAL_CATEGORY,
  type PersonalEnvelope,
} from "../adapter/storage/personal-key-store.ts";
import type { Table } from "../adapter/storage/table.ts";
import type { LogFields, Logger } from "../contracts/logger.ts";
import { isSealed, type PersonalKey } from "../kernel/personal-data/crypto.ts";
import type { PersonalDataWitness } from "../kernel/personal-data/witness.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../modules/bounda-events.ts";
import type { FieldsRecord } from "../modules/view.ts";

export interface LoggedEntry {
  readonly level: keyof Logger;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/**
 * A value a read model kept in a field marked `.personal()`, its category, and how many times its
 * person had been forgotten when it was written: only what was written before a later forgetting
 * of its category is theirs no longer.
 */
interface KeptValue {
  readonly value: unknown;
  readonly category: string;
  readonly forgettings: number;
}

/**
 * The categories a `PersonalDataForgotten` forgot, `null` for every one, as one recorded before
 * categories did.
 */
type Forgetting = readonly string[] | null;

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
   * What the read models kept in their personal fields of the person, in a category forgotten
   * since; with `categories`, in one of those alone.
   */
  keptFor(person: string, categories?: readonly string[]): readonly unknown[];
  /**
   * `adapter`, observed: the same object for the same adapter, so the app still tells it apart
   * from another, as the forget ledger's check that it is not the storage does.
   */
  storage(adapter: Adapter): Adapter;
  logger(logger: Logger): Logger;
}

export interface SealedFor {
  readonly envelope: PersonalEnvelope;
  readonly key: PersonalKey | null;
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
  const keys = new Map<string, Map<string, PersonalKey>>();
  const envelopes = new Map<string, Map<string, PersonalEnvelope>>();
  const kept = new Map<string, KeptValue[]>();
  const forgettings = new Map<string, Forgetting[]>();
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
      const forgot: unknown = Reflect.get(Object(record.payload), "categories");
      forgettings.set(record.aggregateId, [
        ...(forgettings.get(record.aggregateId) ?? []),
        Array.isArray(forgot) ? forgot.map(String) : null,
      ]);
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
    for (const { name, category } of marks.personal) {
      if (row[name] === undefined || row[name] === null) continue;
      values.push({
        value: row[name],
        category,
        forgettings: forgettings.get(person)?.length ?? 0,
      });
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
      if (marks.personal.some(({ name }) => changes[name] !== undefined)) {
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
      const held = keys.get(person) ?? new Map<string, PersonalKey>();
      held.set(key.fingerprint, key);
      keys.set(person, held);
    },
    logs,
    sealedFor: (person) =>
      [...(envelopes.get(person)?.values() ?? [])].map((envelope) => ({
        envelope,
        key: keys.get(person)?.get(envelope.key) ?? null,
      })),
    keptFor: (person, categories) => {
      const since = forgettings.get(person) ?? [];
      return (kept.get(person) ?? [])
        .filter(
          ({ category, forgettings: before }) =>
            (categories === undefined || categories.includes(category)) &&
            since.slice(before).some((forgot) => forgot === null || forgot.includes(category)),
        )
        .map(({ value }) => value);
    },
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
  readonly personal: readonly { readonly name: string; readonly category: string }[];
}

const marksOf = (fields: FieldsRecord): ReadModelMarks => {
  const entries = Object.entries(fields);
  return {
    person: entries.find(([, field]) => field.mark === "person")?.[0] ?? null,
    personal: entries
      .filter(([, field]) => field.mark === "personal")
      .map(([name, field]) => ({ name, category: field.category ?? DEFAULT_PERSONAL_CATEGORY })),
  };
};
