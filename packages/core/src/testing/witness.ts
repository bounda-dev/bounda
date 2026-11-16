import type { Adapter } from "../adapter/adapter.ts";
import type { ForgetLedger } from "../adapter/storage/forget-ledger.ts";
import type { LogFields, Logger } from "../contracts/logger.ts";
import { type RecordedSpan, type RecordedSpanEvent, recordSpans } from "../kernel/span-recorder.ts";
import {
  type AppWitness,
  type WatchedClient,
  WITNESS_HOOKS,
  type Witness,
  type WitnessHooks,
} from "../kernel/witness.ts";
import { createPersonData, type PersonData } from "./person-data.ts";

export interface LoggedEntry {
  readonly level: keyof Logger;
  readonly message: string;
  readonly fields: LogFields | undefined;
  /**
   * Whether the text of errors in it is searched: not when only `createTestApp` made the app
   * write it.
   */
  readonly searchErrorText: boolean;
  /**
   * The tenant of the app that logged it, `null` for what the host logged through the witness,
   * searched for every tenant.
   */
  readonly tenant: string | null;
}

/**
 * The spans one app started, as they stand.
 */
export interface Traced {
  readonly spans: readonly RecordedSpan[];
  readonly spanEvents: readonly RecordedSpanEvent[];
  readonly searchErrorText: boolean;
  readonly tenant: string;
}

/**
 * An app the witness watched, and what it opened.
 */
export interface WatchedApp {
  /**
   * The app, through which `expectTenantForgotten` checks that it refuses every call.
   */
  readonly client: WatchedClient;
  readonly tenant: string;
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
 * Everything the apps a witness watched saw that the expectations need once a person's key is
 * gone: what each tenant's apps did with its persons' data, the logs, the spans and the apps.
 */
export interface TestWitness {
  /**
   * What the app is given, and what stands for this witness in the expectations.
   */
  readonly witness: Witness;
  /**
   * What the apps of `tenant` did with its persons' data.
   */
  of(tenant: string): PersonData;
  readonly logs: readonly LoggedEntry[];
  readonly traces: readonly Traced[];
  /**
   * Every app watched, in the order each started.
   */
  readonly apps: readonly WatchedApp[];
}

/**
 * What a target stands for: a witness, and the tenant of the app it is, `null` for every tenant.
 */
export interface WatchedTarget {
  readonly witness: TestWitness;
  readonly tenant: string | null;
}

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
const targets = new WeakMap<object, WatchedTarget>();

export interface WatchedByFunction {
  (target: object): WatchedTarget | undefined;
}

/**
 * What `target` stands for, `undefined` for anything else.
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
 * which it never replaces, each tenant's apart; then `expectForgotten`, `expectRedacted` and
 * `expectTenantForgotten` take the app, a client of it, or the witness, and search the tables of
 * every app it watches that has not stopped, of the app's tenant or of every one. Give each test a
 * witness of its own, as each records for as long as it is reachable.
 */
export const createWitness: CreateWitnessFunction = () => createTestWitness().witness;

const createTestWitness = (): TestWitness => {
  const tenants = new Map<string, PersonData>();
  const logs: LoggedEntry[] = [];
  const traces: Traced[] = [];
  const apps: WatchedApp[] = [];

  const of = (tenant: string): PersonData => {
    const known = tenants.get(tenant);
    if (known !== undefined) return known;
    const created = createPersonData();
    tenants.set(tenant, created);
    return created;
  };

  const recording = (logger: Logger, searchErrorText: boolean, tenant: string | null): Logger => {
    const record =
      (level: keyof Logger) =>
      (message: string, fields?: LogFields): void => {
        logs.push({ level, message, fields, searchErrorText, tenant });
        logger[level](message, fields);
      };
    return {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    };
  };

  let self: TestWitness;
  const watch = (target: object, tenant: string | null): void => {
    targets.set(target, { witness: self, tenant });
  };

  const hooks: WitnessHooks = {
    attach: ({ searchErrorText, tenant }): AppWitness => {
      const data = of(tenant);
      const { tracer, spans, spanEvents } = recordSpans();
      traces.push({ spans, spanEvents, searchErrorText, tenant });
      const ledgers: ForgetLedger[] = [];
      let watched: { -readonly [K in keyof WatchedApp]: WatchedApp[K] } | undefined;
      return {
        storage: data.storage,
        logger: (logger) => recording(logger, searchErrorText, tenant),
        tracer,
        onPersonalKey: data.onPersonalKey,
        onRedacted: data.onRedacted,
        onForgetLedger: (ledger) => {
          ledgers.push(ledger);
        },
        onApp: (client, adapters) => {
          watched = { client, tenant, adapters, ledgers, stopped: false };
          apps.push(watched);
          watch(client, tenant);
        },
        onStopped: () => {
          if (watched !== undefined) watched.stopped = true;
        },
        watch: (target) => watch(target, tenant),
      };
    },
  };

  const witness = {
    logger: (logger: Logger, like?: object) =>
      recording(logger, true, (like === undefined ? undefined : targets.get(like)?.tenant) ?? null),
    watch: (target: object, like?: object) => {
      targets.set(
        target,
        (like === undefined ? undefined : targets.get(like)) ?? {
          witness: self,
          tenant: null,
        },
      );
    },
    [WITNESS_HOOKS]: hooks,
  } satisfies Witness & { readonly [WITNESS_HOOKS]: WitnessHooks };

  self = { witness, of, logs, traces, apps };
  witness.watch(witness);
  return self;
};
