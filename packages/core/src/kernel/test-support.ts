import { expect, vi } from "vitest";
import type { Storage } from "../adapter/adapter.ts";
import type { PersonalKeyStore, StoredPersonalKey } from "../adapter/storage/personal-key-store.ts";
import type { TenancyStore } from "../adapter/storage/tenancy-store.ts";
import type { TenantKeyStore } from "../adapter/storage/tenant-key-store.ts";
import { selectImplementations } from "../config/ports.ts";
import { resolveConfig } from "../config/schema.ts";
import type { Config, ErrorText, PortsConfig, ResolvedConfig } from "../config/types.ts";
import { type Clock, createFixedClock, type FixedClock } from "../contracts/clock.ts";
import type { CommandRejection } from "../contracts/command.ts";
import { createSequentialIdGenerator, type IdGenerator } from "../contracts/ids.ts";
import { type LogFields, type Logger, silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import { createMemoryTenancyStore } from "../memory/tenancy-store.ts";
import { createMemoryTenantKeyStore } from "../memory/tenant-key-store.ts";
import type { RejectFunction } from "../modules/command.ts";
import type { CommandPayloadArgs, PayloadArgs } from "../modules/payload.ts";
import type { Registry } from "../modules/registry.ts";
import { buildAggregates } from "./aggregate/build-aggregates.ts";
import { createAggregateLoader } from "./aggregate/load-aggregate.ts";
import type { AggregatesRuntime } from "./aggregate/runtime.ts";
import { createCommandPipeline } from "./command/pipeline.ts";
import type { AppStorage } from "./events/app-event-store.ts";
import type { RecordAccess } from "./personal-data/access.ts";
import { createAccessLog } from "./personal-data/access.ts";
import {
  createDisposableKey,
  type PersonalKey,
  TENANT_KEY_ALGORITHM,
  TENANT_KEY_USAGES,
} from "./personal-data/crypto.ts";
import { createForgetIntentions, type ForgetIntentions } from "./personal-data/intention.ts";
import { buildKeyWrapper, type CryptoKeyWrapper } from "./personal-data/key-wrapper.ts";
import { ephemeralMasterKey } from "./personal-data/master-key.ts";
import { marksFingerprint } from "./personal-data/resealing.ts";
import { openTenantKeys, type TenantKeys } from "./personal-data/tenant-keys.ts";
import {
  type CategoryKey,
  createPersonalKeyWrapping,
  type PersonalKeys,
  type PersonalKeyWrapping,
} from "./personal-data/wrapped-keys.ts";
import { createPorts, type ModulePorts } from "./ports/ports.ts";
import type { SealingSource } from "./projection/runner.ts";
import { guardedLogger } from "./shared/guarded-logger.ts";
import { tracer } from "./telemetry.ts";

interface OrderState {
  readonly status: "new" | "placed" | "paid";
  readonly total: number;
}

/**
 * The order aggregate with its precise types, for tests that extend it with policies or processes
 * and want typed facades.
 */
export const orderAggregate = {
  state: { initialState: { status: "new", total: 0 } satisfies OrderState },
  events: {
    orderPlaced: {
      payload: ({ z }: PayloadArgs) => z.object({ total: z.number().positive() }),
      evolve: ({ state, event }: { state: OrderState; event: { payload: { total: number } } }) => ({
        ...state,
        status: "placed" as const,
        total: event.payload.total,
      }),
    },
    orderPaid: {
      payload: ({ z }: PayloadArgs) => z.object({ method: z.enum(["card", "transfer"]) }),
      evolve: ({ state }: { state: OrderState }) => ({ ...state, status: "paid" as const }),
    },
    orderArchived: {
      evolve: ({ state }: { state: OrderState }) => state,
    },
  },
  commands: {
    placeOrder: {
      module: {
        payload: ({ z, notPersonal }: CommandPayloadArgs) =>
          z.object({ orderId: notPersonal(z.string()), total: z.number() }),
        rejections: () => ({ AlreadyPlaced: "Order already placed" }),
        handler: async ({
          command,
          state,
          events,
          notifier,
          idempotencyKey,
          reject,
        }: {
          command: { payload: { orderId: string; total: number }; aggregateId: string };
          state: OrderState & { version: number };
          events: Record<string, (payload?: unknown) => unknown>;
          notifier: { send: (message: string) => void };
          idempotencyKey: string;
          reject: RejectFunction<"AlreadyPlaced">;
        }) => {
          placeOrderKeys.push(idempotencyKey);
          if (state.status !== "new") return reject("AlreadyPlaced");
          notifier.send(`placed ${command.aggregateId} v${state.version}`);
          return [events.orderPlaced?.({ total: command.payload.total })];
        },
      },
    },
    payOrder: {
      module: {
        payload: ({ z, notPersonal }: CommandPayloadArgs) =>
          z.object({ orderId: notPersonal(z.string()), method: z.enum(["card", "transfer"]) }),
        rejections: ({ state }: { state: OrderState }) => ({
          NotPlaced: `Only placed orders can be paid; this one is ${state.status}`,
        }),
        handler: ({
          command,
          state,
          events,
          reject,
        }: {
          command: { payload: { method: "card" | "transfer" } };
          state: OrderState;
          events: Record<string, (payload?: unknown) => unknown>;
          reject: RejectFunction<"NotPlaced">;
        }) => {
          if (state.status !== "placed") throw reject("NotPlaced");
          return [events.orderPaid?.({ method: command.payload.method })];
        },
      },
    },
    archiveOrder: {
      module: {
        payload: ({ z, notPersonal }: CommandPayloadArgs) =>
          z.object({ orderId: notPersonal(z.string()) }),
        handler: ({ events }: { events: Record<string, (payload?: unknown) => unknown> }) => [
          events.orderArchived?.(),
        ],
      },
    },
    touchOrder: {
      module: {
        payload: ({ z, notPersonal }: CommandPayloadArgs) =>
          z.object({ orderId: notPersonal(z.string()) }),
        handler: () => [],
      },
    },
    breakOrder: {
      module: {
        payload: ({ z, notPersonal }: CommandPayloadArgs) =>
          z.object({ orderId: notPersonal(z.string()) }),
        handler: () => [{ type: "CustomerRegistered", payload: {} }],
      },
    },
  },
  policies: {},
  processes: {},
  ports: {
    notifier: {
      memory: { default: { send: (message: string) => sentMessages.push(message) } },
      silent: { default: { send: () => {} } },
    },
  },
} as const satisfies Registry["aggregates"][string];

export const orderAggregateEntry = (): typeof orderAggregate => orderAggregate;

/**
 * The order aggregate used by kernel tests, written as a user would in module style.
 */
export const orderRegistry: Registry = {
  aggregates: { order: orderAggregate },
  readModels: {},
};

export interface JobHandlerArgs {
  readonly signal: AbortSignal;
  readonly events: Record<string, (payload?: unknown) => unknown>;
}

export interface WithJobFunction {
  (handler: (args: JobHandlerArgs) => unknown, base?: Registry): Registry;
}

/**
 * `base` plus a `job` aggregate whose one command, `RunJob` (`{ jobId }`), runs `handler`, and
 * whose one event is `JobDone`: for tests that decide when a command finishes.
 */
export const withJob: WithJobFunction = (handler, base = { aggregates: {}, readModels: {} }) => ({
  ...base,
  aggregates: {
    ...base.aggregates,
    job: {
      events: { jobDone: { evolve: ({ state }: { state: object }) => state } },
      commands: { runJob: { module: { handler } } },
      policies: {},
      processes: {},
    },
  },
});

export interface SlowJob {
  readonly registry: Registry;
  /**
   * Resolves with the handler's signal once `RunJob`'s handler runs.
   */
  readonly started: Promise<AbortSignal>;
  /**
   * Lets the handler return `JobDone`; until then it waits.
   */
  finish(): void;
}

export interface SlowJobFunction {
  (base?: Registry): SlowJob;
}

export const slowJob: SlowJobFunction = (base) => {
  const started = Promise.withResolvers<AbortSignal>();
  const finished = Promise.withResolvers<void>();
  const registry = withJob(async ({ signal, events }) => {
    started.resolve(signal);
    await finished.promise;
    return [events.jobDone?.()];
  }, base);
  return { registry, started: started.promise, finish: () => finished.resolve() };
};

/**
 * The `ports` configuration kernel tests boot with: the in-memory notifier for a registry
 * built on `orderAggregate`, nothing for any other.
 */
export const defaultPorts = (registry: Registry): PortsConfig =>
  registry.aggregates.order?.ports?.notifier === undefined ? {} : { order: { notifier: "memory" } };

/**
 * What `createPorts` builds, chosen synchronously, for kernel tests that build aggregates
 * by hand from a registry whose implementations are all default exports.
 */
export interface ChoosePortsFunction {
  (registry: Registry, config: ResolvedConfig): ModulePorts;
}

export const choosePorts: ChoosePortsFunction = (registry, config) =>
  Object.fromEntries(
    Object.entries(registry.aggregates).map(([aggregate, entry]) => [
      aggregate,
      Object.fromEntries(
        Object.entries(
          selectImplementations({
            owner: { kind: "aggregate", name: aggregate },
            implementations: entry.ports ?? {},
            config: config.ports[aggregate],
          }),
        ).map(([port, module]) => [port, module.default]),
      ),
    ]),
  );

/**
 * Messages sent through the in-memory notifier port, reset by `createKernelHarness`.
 */
export const sentMessages: string[] = [];

/**
 * The `idempotencyKey` of every run of the `placeOrder` handler, reset by `createKernelHarness`.
 */
export const placeOrderKeys: string[] = [];

export interface LogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields?: LogFields;
}

export interface RecordingLogger {
  readonly logger: Logger;
  readonly entries: LogEntry[];
}

export interface CreateRecordingLoggerFunction {
  (errorText?: ErrorText): RecordingLogger;
}

/**
 * A logger that keeps every line, for tests that assert on what the kernel reports. Errors are
 * logged as the runtime logs them, with their text unless `errorText` is `"omit"`.
 */
export const createRecordingLogger: CreateRecordingLoggerFunction = (errorText = "include") => {
  const entries: LogEntry[] = [];
  const record =
    (level: LogEntry["level"]) =>
    (message: string, fields?: LogFields): void => {
      entries.push(fields === undefined ? { level, message } : { level, message, fields });
    };
  return {
    logger: guardedLogger(
      {
        debug: record("debug"),
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
      },
      errorText,
    ),
    entries,
  };
};

export interface KernelHarness {
  readonly storage: Storage;
  readonly config: ResolvedConfig;
  readonly aggregates: AggregatesRuntime;
  readonly clock: FixedClock;
  readonly pipeline: ReturnType<typeof createCommandPipeline>;
  /**
   * What the pipeline reported to `onRejection`, in order.
   */
  readonly rejections: readonly CommandRejection[];
}

export interface CreateKernelHarnessArgs {
  readonly config?: Partial<Omit<Config, "storage">>;
  readonly registry?: Registry;
  /**
   * What the pipeline logs to; silent by default.
   */
  readonly logger?: Logger;
}

export interface CreateKernelHarnessFunction {
  (args?: CreateKernelHarnessArgs): Promise<KernelHarness>;
}

/**
 * Boots the order aggregate on the in-memory adapter with deterministic ids and clock.
 */
export const createKernelHarness: CreateKernelHarnessFunction = async ({
  config: overrides = {},
  registry = orderRegistry,
  logger = silentLogger,
} = {}) => {
  sentMessages.length = 0;
  placeOrderKeys.length = 0;
  const adapter = memory();
  const clock = createFixedClock();
  const storage = withPersonalKeys(await adapter.createStorage(), clock);
  const config = resolveConfig({
    storage: adapter,
    ports: defaultPorts(registry),
    ...overrides,
  });
  const { byAggregate } = await createPorts({
    registry,
    config: config.ports,
    env: {},
    logger: silentLogger,
    clock,
  });
  const aggregates = buildAggregates({ registry, ports: byAggregate, config });
  const loader = createAggregateLoader({
    snapshotStore: storage.snapshotStore,
    logger,
    strict: true,
  });
  const rejections: CommandRejection[] = [];
  const pipeline = createCommandPipeline({
    tracer: tracer,
    aggregates,
    loader,
    storage,
    config,
    ids: createSequentialIdGenerator(),
    clock,
    logger,
    recordAccess: createAccessLog({ hook: undefined, env: {}, tenant: undefined, logger, clock }),
    onRejection: (rejection) => rejections.push(rejection),
    marks: marksFingerprint({ aggregates, processes: { all: [] } }),
  });
  return { storage, config, aggregates, clock, pipeline, rejections };
};

export interface EventuallyFunction {
  <T>(assertion: () => T | Promise<T>): Promise<T>;
}

/**
 * Retries `assertion` until it passes. For conditions that background work makes true without any
 * time passing on the clock, so they hold within microseconds once the work has run.
 */
export const eventually: EventuallyFunction = (assertion) =>
  vi.waitFor(assertion, { interval: 1, timeout: 5_000 });

export interface DrainedFunction {
  (): Promise<void>;
}

/**
 * Resolves after every microtask queued so far has run, and the I/O callbacks due with them.
 */
export const drained: DrainedFunction = () => new Promise((resolve) => setImmediate(resolve));

export interface AdvanceUntilWaitingFunction {
  (clock: FixedClock, milliseconds: number): Promise<void>;
}

/**
 * Moves the clock forward, then waits until the background loops that were waiting on it are
 * waiting again: whatever the move woke up has run its pass and re-armed.
 */
export const advanceUntilWaiting: AdvanceUntilWaitingFunction = async (clock, milliseconds) => {
  const waiting = clock.pending();
  clock.advance(milliseconds);
  await eventually(() => expect(clock.pending()).toBe(waiting));
};

/**
 * What a process `config` of the order aggregate receives in kernel tests: the order events by
 * qualified name, `events.order.OrderPlaced`.
 */
export interface OrderProcessConfigArgs<Names extends string> {
  readonly events: { readonly order: { readonly [Name in Names]: `order.${Name}` } };
}

export interface BrokenCommit {
  readonly broke: () => boolean;
}

export interface BreakNextCommitFunction {
  (storage: Storage): BrokenCommit;
}

/**
 * Breaks the next commit that goes through `transact`: the work runs, then the transaction fails
 * the way a lost connection or a crash would, so nothing it staged is written.
 */
export const breakNextCommit: BreakNextCommitFunction = (storage) => {
  const transact = storage.transact.bind(storage);
  let broken = false;
  storage.transact = (work) =>
    transact(async (tx) => {
      const result = await work(tx);
      if (!broken) {
        broken = true;
        throw new Error("connection lost");
      }
      return result;
    });
  return { broke: () => broken };
};

/**
 * An access log that records nothing, for tests of what does not look at it.
 */
export const unrecordedAccess: RecordAccess = async () => undefined;

// Generated once, for every test of the process: a key stored by one opens in another.
let testTenantKey: Promise<CryptoKey> | null = null;
const tenantKeyOfTests = (): Promise<CryptoKey> => {
  testTenantKey ??= crypto.subtle.generateKey({ name: TENANT_KEY_ALGORITHM, length: 256 }, false, [
    ...TENANT_KEY_USAGES,
  ]);
  return testTenantKey;
};

/**
 * The id of the tenant key every test wraps persons' keys under.
 */
export const TEST_TENANT_KID = "test-tenant-key";

/**
 * A tenant's keys for tests: one version, generated once per process, which never forgets.
 */
export const testTenantKeys: TenantKeys = {
  tenant: "test",
  store: "test-store",
  current: async () => ({ kid: TEST_TENANT_KID, key: await tenantKeyOfTests() }),
  keyOf: async (kid) => (kid === TEST_TENANT_KID ? tenantKeyOfTests() : null),
  knows: (kid) => kid === TEST_TENANT_KID,
  kids: async () => ({ kid: TEST_TENANT_KID, previous: [], since: new Date(0).toISOString() }),
  forgotten: () => null,
  refresh: async () => null,
  rotate: async () => TEST_TENANT_KID,
  retire: async () => [],
  forget: async (forgetting) => forgetting,
  releaseFiles: async () => false,
  rewrapUnderMaster: async () => 0,
  underPreviousMaster: () => false,
  status: async () => ({
    tenant: "test",
    forgottenAt: null,
    kid: TEST_TENANT_KID,
    previous: [],
    master: { kid: "test-master", previous: [], pending: 0 },
  }),
  close: () => undefined,
};

/**
 * A master key that wraps nothing: the persons' keys of tests are all under the tenant's.
 */
export const testMaster: Pick<CryptoKeyWrapper, "kid" | "previous" | "unwrap"> = {
  kid: "test-master",
  previous: [],
  unwrap: async () => {
    throw new Error("No key of a test is wrapped under the master key");
  },
};

export interface OpenTestTenantKeysArgs {
  readonly master?: CryptoKeyWrapper;
  readonly store?: TenantKeyStore;
  readonly tenancy?: TenancyStore;
  readonly tenant?: string;
  readonly clock?: Clock;
}

export interface OpenTestTenantKeysFunction {
  (args?: OpenTestTenantKeysArgs): Promise<TenantKeys>;
}

/**
 * A tenant's keys as an app opens them, in stores of its own unless given, under an ephemeral
 * master key unless given.
 */
export const openTestTenantKeys: OpenTestTenantKeysFunction = async ({
  master,
  store = createMemoryTenantKeyStore(),
  tenancy = createMemoryTenancyStore(),
  tenant = "acme",
  clock = createFixedClock(),
} = {}) =>
  openTenantKeys({
    tenant,
    store,
    tenancy,
    master: master ?? (await buildKeyWrapper({ definition: ephemeralMasterKey(), env: {} })),
    clock,
    holdsTenantWrapped: async () => false,
  });

export interface TestWrappingFunction {
  (clock?: Clock): PersonalKeyWrapping;
}

/**
 * The persons' keys of tests, wrapped under the tenant key of tests.
 */
export const testWrapping: TestWrappingFunction = (clock = createFixedClock()) =>
  createPersonalKeyWrapping({ tenantKeys: testTenantKeys, master: testMaster, clock });

export interface KeysOverFunction {
  (keys: PersonalKeyStore, clock?: Clock): PersonalKeys;
}

/**
 * A store's keys as the kernel reads them, wrapped under the tenant key of tests.
 */
export const keysOver: KeysOverFunction = (keys, clock = createFixedClock()) =>
  testWrapping(clock).over(keys);

export interface WithPersonalKeysFunction {
  (storage: Storage, clock?: Clock): AppStorage;
}

/**
 * The storage with its keys, and those of its transactions, as the kernel reads them; its event
 * store as written, and remembered answers kept in the clear.
 */
export const withPersonalKeys: WithPersonalKeysFunction = (storage, clock = createFixedClock()) => {
  const wrapping = testWrapping(clock);
  return {
    ...storage,
    personalKeys: wrapping.over(storage.personalKeys),
    atRest: null,
    transact: (work) =>
      storage.transact((transaction) =>
        work({ ...transaction, personalKeys: wrapping.over(transaction.personalKeys) }),
      ),
  };
};

export interface RemoveKeysFunction {
  (keys: PersonalKeyStore, person: string): Promise<boolean>;
}

/**
 * Removes every key the person holds, as forgetting the whole person on another instance would,
 * and reports whether they held any.
 */
export const removeKeys: RemoveKeysFunction = async (keys, person) => {
  const held = await keys.list(person);
  for (const { key } of held) await keys.remove(person, key.fingerprint);
  return held.length > 0;
};

export interface NewStoredKeyFunction {
  (): Promise<StoredPersonalKey>;
}

/**
 * A new key as a store keeps it, wrapped under the tenant key of tests.
 */
export const newStoredKey: NewStoredKeyFunction = async () =>
  (await testWrapping().generate()).stored;

export interface OpenedKeyFunction {
  (stored: StoredPersonalKey): Promise<PersonalKey>;
}

/**
 * A key wrapped under the tenant key of tests, as the kernel seals and opens with it.
 */
export const openedKey: OpenedKeyFunction = async (stored) => ({
  fingerprint: stored.fingerprint,
  cryptoKey: await testWrapping().unwrap(stored),
  retained: false,
});

export interface WithoutLedgerArgs {
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * The intentions of an app without a forget ledger: ids and times, nothing recorded.
 */
export const withoutLedger = ({ ids, clock }: WithoutLedgerArgs): ForgetIntentions =>
  createForgetIntentions({ ledger: null, ids, clock, logger: silentLogger });

/**
 * What read models seal with when no person has a key: what a test of read models without
 * personal fields runs on.
 */
export const keylessSealing: SealingSource = {
  keys: { heldAllOf: async () => new Map(), discarded: () => createDisposableKey() },
  indexer: null,
  redactions: async () => [],
};

export interface EachPersonFunction {
  (
    keysOf: (person: string) => readonly CategoryKey[] | Promise<readonly CategoryKey[]>,
  ): Pick<PersonalKeys, "heldAllOf" | "discarded">;
}

/**
 * Keys read for several persons at once, from what `keysOf` gives each.
 */
export const eachPerson: EachPersonFunction = (keysOf) => ({
  heldAllOf: async (persons) =>
    new Map(
      await Promise.all(persons.map(async (person) => [person, await keysOf(person)] as const)),
    ),
  discarded: () => createDisposableKey(),
});
