import type { Tracer } from "@opentelemetry/api";
import { type Adapter, isAdapter } from "../adapter/adapter.ts";
import type { ForgetLedger } from "../adapter/storage/forget-ledger.ts";
import type { Config } from "../config/types.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import type { Logger } from "../contracts/logger.ts";
import type { BoundaClient } from "./app.ts";
import type { PersonalKey } from "./personal-data/crypto.ts";

/**
 * What the expectations call on an app the witness watched.
 */
export type WatchedClient = Pick<BoundaClient, "exportPersonalData">;

/**
 * What `createWitness()` from `@bounda-dev/core/testing` returns, for tests: given to `createApp`
 * or `boot()` as `witness`, it records what the app seals, what its read models keep, what it logs
 * and the spans it starts, beside any tracer provider registered, so `expectForgotten`,
 * `expectRedacted` and `expectTenantForgotten` search all of it once given the app, a client of
 * it, or the witness. An app given none records nothing and costs nothing more.
 */
export interface Witness {
  /**
   * `logger`, whose every entry the witness keeps for the expectations to search: for what a host
   * or a test logs beside the app.
   */
  logger(logger: Logger): Logger;
  /**
   * Makes `target` stand for the witness in the expectations, or for what `like` stands for, an
   * app or a client: for a host that serves the app behind an object of its own, as
   * `createBoundaObject` does with the Durable Object.
   */
  watch(target: object, like?: object): void;
}

/**
 * What a witness is told of by one app it watches.
 */
export interface AppWitness {
  /**
   * `adapter`, observed: the same object for the same adapter, so the app still tells it apart
   * from another, as the forget ledger's check that it is not the storage does.
   */
  storage(adapter: Adapter): Adapter;
  logger(logger: Logger): Logger;
  /**
   * Starts a copy of every span the app starts.
   */
  readonly tracer: Tracer;
  onPersonalKey(person: string, key: PersonalKey): void;
  onForgetLedger(ledger: ForgetLedger): void;
  /**
   * The values a redaction made unreadable, as they read before, and the key it sealed them under
   * and let go.
   */
  onRedacted(person: string, values: readonly unknown[], key: PersonalKey): void;
  /**
   * The app has started: `client` stands for the witness, and the expectations search `adapters`
   * until `onStopped`.
   */
  onApp(client: WatchedClient, adapters: readonly Adapter[]): void;
  onStopped(): void;
  watch(target: object): void;
}

export interface AttachWitnessArgs {
  /**
   * Whether the text of errors in what the app logs and traces is searched: not when only the
   * test harness made the app write it.
   */
  readonly searchErrorText: boolean;
  /**
   * The tenant the app serves: what each tenant's apps do with its persons' data is kept apart.
   */
  readonly tenant: string;
}

export interface WitnessHooks {
  attach(args: AttachWitnessArgs): AppWitness;
}

/**
 * Where a witness keeps its hooks. `Symbol.for`, so a second copy of this module still finds them.
 */
export const WITNESS_HOOKS: unique symbol = Symbol.for("@bounda-dev/core/witness");

export interface WitnessHooksOfFunction {
  (witness: Witness): WitnessHooks;
}

export const witnessHooksOf: WitnessHooksOfFunction = (witness) => {
  const hooks: unknown = Reflect.get(witness, WITNESS_HOOKS);
  if (typeof hooks !== "object" || hooks === null) {
    throw new ConfigurationError(
      "witness must be what createWitness() from @bounda-dev/core/testing returns",
    );
  }
  return hooks as WitnessHooks;
};

export interface WitnessedConfigFunction {
  (config: Config, witness: AppWitness): Config;
}

/**
 * `config` with every adapter it names observed: the storage, each read model's, and the forget
 * ledger's, the same observed adapter as the storage's when it is the storage's, which the app
 * refuses.
 */
export const witnessedConfig: WitnessedConfigFunction = (config, witness) => {
  const observed = <T>(store: T): T | Adapter =>
    isAdapter(store) ? witness.storage(store) : store;
  const ledger = config.runtime?.personalData?.forgetLedger;
  return {
    ...config,
    storage: observed(config.storage),
    ...(config.readModels === undefined
      ? {}
      : {
          readModels: Object.fromEntries(
            Object.entries(config.readModels).map(([name, store]) => [name, observed(store)]),
          ),
        }),
    ...(ledger === undefined || !isAdapter(ledger.store)
      ? {}
      : {
          runtime: {
            ...config.runtime,
            personalData: {
              ...config.runtime?.personalData,
              forgetLedger: { ...ledger, store: witness.storage(ledger.store) },
            },
          },
        }),
  };
};
