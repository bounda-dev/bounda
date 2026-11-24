import type { Adapter, EphemeralKeys } from "../adapter/adapter.ts";
import type { Config } from "../config/types.ts";
import { createFixedClock, type FixedClock } from "../contracts/clock.ts";
import type { ConfigurationError, SnapshotError } from "../contracts/errors.ts";
import { createSequentialIdGenerator, type IdGenerator } from "../contracts/ids.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import { assembleApp, type BoundaApp } from "../kernel/app.ts";
import { createEphemeralKeys } from "../kernel/personal-data/ephemeral-keys.ts";
import { createPendingRetries } from "../kernel/shared/pending-retries.ts";
import { memory } from "../memory/index.ts";
import type { OnPersonalDataAccess } from "../modules/audit.ts";
import type { Registry } from "../modules/registry.ts";
import type { AppPortsConfig, AppTestPorts, EnvSection } from "../register/index.ts";
import { testWitnessOf } from "./witness.ts";

/**
 * `env` is what port implementations receive in `create`, never the test's
 * `process.env`; `EnvSection` says when it is required.
 */
export type CreateTestAppArgs<R extends Registry> = {
  readonly registry: R;
  /**
   * Configuration without `storage`, which `adapter` replaces, nor `ports`, which the
   * option of that name replaces. `runtime.telemetry.errorText` defaults to `"include"`, so a
   * failing test logs what failed.
   */
  readonly config?: Omit<Config, "storage" | "ports">;
  /**
   * What each port of each aggregate or read model receives, `{ order: { notifier: spy } }`: a double, handed
   * to the handlers as it is and never closed, or an implementation's file name, built with this
   * app's `env`, clock and logger and closed by `app.stop()`. A port left out has no
   * implementation, even when it has only one, so a test never reaches a provider it did not ask
   * for: reading it throws a `ConfigurationError`, which a command rejects with; once any handler
   * has read it, every `app.runUntilIdle()` throws it too, since a reaction does not retry it.
   */
  readonly ports?: AppTestPorts;
  /**
   * Defaults to the in-memory adapter. Without `runtime.personalData.keyWrapper` and
   * `runtime.personalData.tenantKeys`, the app holds its keys in memory, the same for every test
   * app over the same adapter, so one opens what another sealed.
   */
  readonly adapter?: Adapter;
  readonly logger?: Logger;
  /**
   * Where the fixed clock starts. Defaults to 2026-01-01T00:00:00Z.
   */
  readonly now?: Date;
  /**
   * The name of the store, which an implementation `ports` names receives in `create` as
   * `tenant`, as it would in that tenant's Durable Object. Left out, it receives
   * `DEFAULT_TENANT`.
   */
  readonly tenant?: string;
  /**
   * Where the access log goes, in place of the project's `app/audit.ts`, which a test app never
   * calls, as it reaches no port the test did not ask for. Left out, the records go to `logger`.
   */
  readonly onPersonalDataAccess?: OnPersonalDataAccess;
} & EnvSection<R>;

/**
 * A test app and what it runs on. Stop it with `app.stop()` when the test ends.
 */
export interface TestApp<R extends Registry> {
  /**
   * The app, whose `runUntilIdle()` throws the `ConfigurationError` of a port the test left out
   * once a handler has read it, and the `SnapshotError` of a snapshot that did not stand for its
   * stream.
   */
  readonly app: BoundaApp<R>;
  /**
   * The app's clock. Advance it to make scheduled commands, process time-outs and retention
   * deadlines due, then call `app.runUntilIdle()`, which moves it on its own only while a retry
   * waits for its back-off: to that retry, stopping first at a scheduled command due before it,
   * never at a retention deadline.
   */
  readonly clock: FixedClock;
  /**
   * The ids the app hands out, in sequence: `id-1`, `id-2` and so on.
   */
  readonly ids: IdGenerator;
}

export interface CreateTestAppFunction {
  <R extends Registry>(args: CreateTestAppArgs<R>): Promise<TestApp<R>>;
}

export interface CreateTestKeysFunction {
  (): EphemeralKeys;
}

/**
 * A master key and a tenant key store in memory, for test apps that open one database through
 * adapters of their own, as two instances of the app would: pass both to each app's
 * `runtime.personalData`, and each opens what the others sealed. An app given one adapter needs
 * none of this, as `createTestApp` keeps the keys of each adapter it was given.
 */
export const createTestKeys: CreateTestKeysFunction = () => createEphemeralKeys();

// The keys of each adapter a test app was given without any, the same for every app over it.
const testKeys = new WeakMap<Adapter, EphemeralKeys>();

const testKeysOf = (adapter: Adapter): EphemeralKeys => {
  const known = testKeys.get(adapter);
  if (known !== undefined) return known;
  const created = createTestKeys();
  testKeys.set(adapter, created);
  return created;
};

/**
 * Creates an app for tests: in-memory storage, a clock that only moves when told to and
 * sequential ids (`id-1`, `id-2`, ...), so assertions are deterministic. Ports get only what
 * `ports` passes. `app.runUntilIdle()` also moves the clock to each retry waiting for its
 * back-off, running what falls due on the way, so the failures it can see have gone through or
 * given up when it resolves. Call `app.stop()` when done.
 */
export const createTestApp: CreateTestAppFunction = async <R extends Registry>({
  registry,
  config = {},
  ports = {},
  adapter = memory(),
  logger = silentLogger,
  now,
  env = {},
  tenant,
  onPersonalDataAccess,
}: CreateTestAppArgs<R>): Promise<TestApp<R>> => {
  const clock = createFixedClock(now);
  const ids = createSequentialIdGenerator();
  // What the witness saw on the way in, which the tables no longer show once a person is
  // forgotten: the expectations search it beside every table the app opened.
  const { witness } = testWitnessOf(adapter);
  // A reaction's failure stays in its dead letter, so the first port read without a value is
  // kept here for `runUntilIdle` to throw: the test fails saying what to pass.
  let missing: ConfigurationError | SnapshotError | undefined;
  const named = config.runtime?.personalData;
  // An adapter whose data outlives the process, given without keys, gets keys of its own in
  // memory: every app the test builds over it opens what an earlier one sealed.
  const keys =
    named?.keyWrapper === undefined &&
    named?.tenantKeys === undefined &&
    adapter.ephemeralKeys === undefined
      ? testKeysOf(adapter)
      : undefined;
  const app = await assembleApp<R>({
    registry,
    // Required by the `Config` of a project whose ports need a choice, and never read here:
    // `test` replaces it.
    config: {
      ...config,
      runtime: {
        ...config.runtime,
        telemetry: { errorText: "include", ...config.runtime?.telemetry },
        personalData: { ...named, ...(keys ?? {}) },
      },
      storage: adapter,
      ports: {} as AppPortsConfig,
    },
    logger,
    witness,
    // The text of errors is there only because a test app includes it, unless the test chose.
    searchErrorText: config.runtime?.telemetry?.errorText !== undefined,
    ids,
    clock,
    env,
    tenant,
    pendingRetries: createPendingRetries(clock),
    onPersonalDataAccess,
    test: {
      ports,
      onMissing: (error) => {
        missing ??= error;
      },
      onSnapshotError: (error) => {
        missing ??= error;
      },
    },
  });
  const tested: BoundaApp<R> = {
    ...app,
    runUntilIdle: async (options) => {
      const result = await app.runUntilIdle(options);
      if (missing !== undefined) throw missing;
      return result;
    },
  };
  witness.watch(tested);
  return { app: tested, clock, ids };
};

export type { EphemeralKeys } from "../adapter/adapter.ts";
export { createFixedClock, type FixedClock } from "../contracts/clock.ts";
export { createSequentialIdGenerator } from "../contracts/ids.ts";
export { silentLogger } from "../contracts/logger.ts";
export { MIN_SUBSTRING_LENGTH } from "../kernel/shared/value-search.ts";
export type { Witness } from "../kernel/witness.ts";
export { memory } from "../memory/index.ts";
export type {
  ExpectForgottenFunction,
  ExpectForgottenOptions,
  ExpectForgottenTarget,
  ExpectTenantForgottenFunction,
  ExpectTenantForgottenOptions,
  ForgottenValueFound,
} from "./expect-forgotten.ts";
export {
  expectForgotten,
  expectTenantForgotten,
  NotForgottenError,
  TenantNotForgottenError,
} from "./expect-forgotten.ts";
export type {
  ExpectRedactedFunction,
  ExpectRedactedOptions,
  ExpectRedactedTarget,
  RedactedValueFound,
} from "./expect-redacted.ts";
export { expectRedacted, NotRedactedError } from "./expect-redacted.ts";
export type {
  ExpectRestrictedFunction,
  ExpectRestrictedOptions,
  RestrictedValueFound,
} from "./expect-restricted.ts";
export { expectRestricted, NotRestrictedError } from "./expect-restricted.ts";
export { type CreateWitnessFunction, createWitness } from "./witness.ts";
