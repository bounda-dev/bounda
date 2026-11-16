import type {
  Adapter,
  ReadModelRebuild,
  ReadModelStorage,
  ReadModelTransaction,
  Storage,
  StorageTransaction,
} from "../adapter/adapter.ts";
import type { ForgetLedger } from "../adapter/storage/forget-ledger.ts";
import {
  DEFAULT_PERSONAL_CATEGORY,
  type PersonalEnvelope,
} from "../adapter/storage/personal-key-store.ts";
import type { Table } from "../adapter/storage/table.ts";
import type { LogFields, Logger } from "../contracts/logger.ts";
import { isSealed, type PersonalKey } from "../kernel/personal-data/crypto.ts";
import { parseEnvelope } from "../kernel/read-model/sealed-rows.ts";
import { type RecordedSpan, type RecordedSpanEvent, recordSpans } from "../kernel/span-recorder.ts";
import {
  type AppWitness,
  type WatchedClient,
  WITNESS_HOOKS,
  type Witness,
  type WitnessHooks,
} from "../kernel/witness.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../modules/bounda-events.ts";
import type { FieldsRecord } from "../modules/view.ts";

export interface LoggedEntry {
  readonly level: keyof Logger;
  readonly message: string;
  readonly fields: LogFields | undefined;
  /**
   * Whether the text of errors in it is searched: not when only `createTestApp` made the app
   * write it.
   */
  readonly searchErrorText: boolean;
}

/**
 * The spans one app started, as they stand.
 */
export interface Traced {
  readonly spans: readonly RecordedSpan[];
  readonly spanEvents: readonly RecordedSpanEvent[];
  readonly searchErrorText: boolean;
}

/**
 * An app the witness watched, and what it opened.
 */
export interface WatchedApp {
  /**
   * The app, through which `expectTenantForgotten` checks that it refuses every call.
   */
  readonly client: WatchedClient;
  readonly adapters: readonly Adapter[];
  /**
   * The forget ledger the app opened, which closes with it.
   */
  readonly ledgers: readonly ForgetLedger[];
  /**
   * Whether `app.stop()` was called: an in-memory database is gone then, and a ledger closed.
   */
  readonly stopped: boolean;
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
 * Everything the apps a witness watched saw that the expectations need once the person's key is
 * gone: the values sealed under each key, the keys, what the read models kept of each person, the
 * logs, the spans and the apps themselves.
 */
export interface TestWitness {
  /**
   * What the app is given, and what stands for this witness in the expectations.
   */
  readonly witness: Witness;
  /**
   * The values the person's redactions made unreadable, as they read before.
   */
  redactedFor(person: string): readonly unknown[];
  /**
   * The person's key of that fingerprint, as the test app held it, `null` when it never did.
   */
  keyOf(person: string, fingerprint: string): PersonalKey | null;
  readonly logs: readonly LoggedEntry[];
  readonly traces: readonly Traced[];
  /**
   * Every app watched, in the order each started.
   */
  readonly apps: readonly WatchedApp[];
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
   * Every person the test app sealed a value of, or a read model kept one of.
   */
  persons(): readonly string[];
  /**
   * Everything the read models kept in their personal fields of the person, whatever was forgotten
   * since.
   */
  allKeptFor(person: string): readonly unknown[];
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

// What each target stands for: the witness itself, every app it watched, the clients of each.
const targets = new WeakMap<object, TestWitness>();

export interface WatchedByFunction {
  (target: object): TestWitness | undefined;
}

/**
 * The witness `target` stands for, `undefined` for anything else.
 */
export const watchedBy: WatchedByFunction = (target) => targets.get(target);

export interface CreateWitnessFunction {
  (): Witness;
}

/**
 * Creates a witness, for tests of an app built otherwise than with `createTestApp`, which has one
 * of its own: give it to `createApp`, `boot()` or `createBounda` from
 * `@bounda-dev/react-router` as `witness`, or to the Durable Objects of a class through
 * `witnessObjects` from `@bounda-dev/cloudflare/testing`. It records what every app given it
 * seals, keeps, logs and traces from then on, its spans beside any tracer provider registered,
 * which it never replaces; then `expectForgotten`, `expectRedacted` and `expectTenantForgotten`
 * take the app, a client of it, or the witness, and search the tables of every app it watches that
 * has not stopped. Give each test a witness of its own, as each records for as long as it is
 * reachable.
 */
export const createWitness: CreateWitnessFunction = () => createTestWitness().witness;

const createTestWitness = (): TestWitness => {
  const keys = new Map<string, Map<string, PersonalKey>>();
  const envelopes = new Map<string, Map<string, PersonalEnvelope>>();
  const kept = new Map<string, KeptValue[]>();
  const forgettings = new Map<string, Forgetting[]>();
  const logs: LoggedEntry[] = [];
  const traces: Traced[] = [];
  const apps: WatchedApp[] = [];
  const wrapped = new WeakMap<Adapter, Adapter>();
  const redacted = new Map<string, unknown[]>();

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
      // A sealed field holds the JSON of its envelope: known as any other envelope is.
      const envelope = parseEnvelope(row[name]);
      if (envelope !== null) {
        observeArgs([envelope]);
        continue;
      }
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
    (level: keyof Logger, logger: Logger, searchErrorText: boolean) =>
    (message: string, fields?: LogFields): void => {
      logs.push({ level, message, fields, searchErrorText });
      logger[level](message, fields);
    };

  const recording = (logger: Logger, searchErrorText: boolean): Logger => ({
    debug: record("debug", logger, searchErrorText),
    info: record("info", logger, searchErrorText),
    warn: record("warn", logger, searchErrorText),
    error: record("error", logger, searchErrorText),
  });

  const storage = function observe(adapter: Adapter): Adapter {
    const existing = wrapped.get(adapter);
    if (existing !== undefined) return existing;
    const file = adapter.encryptedFile;
    const observing: Adapter = {
      ...adapter,
      // The adapter the app opens the file through is observed in its place.
      ...(file === undefined
        ? {}
        : { encryptedFile: { ...file, open: async (args) => observe(await file.open(args)) } }),
      createStorage: async () => observedStorage(await adapter.createStorage()),
      createReadModel: async (args) =>
        readModelStorage(await adapter.createReadModel(args), marksOf(args.fields)),
      rebuildReadModel: async (args) =>
        readModelRebuild(await adapter.rebuildReadModel(args), marksOf(args.fields)),
    };
    wrapped.set(adapter, observing);
    return observing;
  };

  const onPersonalKey = (person: string, key: PersonalKey): void => {
    const held = keys.get(person) ?? new Map<string, PersonalKey>();
    held.set(key.fingerprint, key);
    keys.set(person, held);
  };

  // The key a redaction let go opens what it sealed, as a key a forgetting destroyed does.
  const onRedacted = (person: string, values: readonly unknown[], key: PersonalKey): void => {
    onPersonalKey(person, key);
    redacted.set(person, [...(redacted.get(person) ?? []), ...values]);
  };

  let self: TestWitness;
  const watch = (target: object): void => {
    targets.set(target, self);
  };

  const hooks: WitnessHooks = {
    attach: ({ searchErrorText }): AppWitness => {
      const { tracer, spans, spanEvents } = recordSpans();
      traces.push({ spans, spanEvents, searchErrorText });
      const ledgers: ForgetLedger[] = [];
      let watched: { -readonly [K in keyof WatchedApp]: WatchedApp[K] } | undefined;
      return {
        storage,
        logger: (logger) => recording(logger, searchErrorText),
        tracer,
        onPersonalKey,
        onRedacted,
        onForgetLedger: (ledger) => {
          ledgers.push(ledger);
        },
        onApp: (client, adapters) => {
          watched = { client, adapters, ledgers, stopped: false };
          apps.push(watched);
          watch(client);
        },
        onStopped: () => {
          if (watched !== undefined) watched.stopped = true;
        },
        watch,
      };
    },
  };

  const witness = {
    logger: (logger: Logger) => recording(logger, true),
    watch,
    [WITNESS_HOOKS]: hooks,
  } satisfies Witness & { readonly [WITNESS_HOOKS]: WitnessHooks };

  self = {
    witness,
    redactedFor: (person) => redacted.get(person) ?? [],
    keyOf: (person, fingerprint) => keys.get(person)?.get(fingerprint) ?? null,
    logs,
    traces,
    apps,
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
    persons: () => [...new Set([...envelopes.keys(), ...kept.keys()])],
    allKeptFor: (person) => (kept.get(person) ?? []).map(({ value }) => value),
  };
  watch(witness);
  return self;
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
