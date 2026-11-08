import { type Adapter, isAdapter } from "../adapter/adapter.ts";
import type { ForgetLedger } from "../adapter/storage/forget-ledger.ts";
import type { Config } from "../config/types.ts";
import { createFixedClock, type FixedClock } from "../contracts/clock.ts";
import type { ConfigurationError, SnapshotError } from "../contracts/errors.ts";
import { createSequentialIdGenerator, type IdGenerator } from "../contracts/ids.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import { assembleApp, type BoundaApp } from "../kernel/app.ts";
import { createPendingRetries } from "../kernel/shared/pending-retries.ts";
import { memory } from "../memory/index.ts";
import type { OnPersonalDataAccess } from "../modules/audit.ts";
import type { Registry } from "../modules/registry.ts";
import type { AppPortsConfig, AppTestPorts, EnvSection } from "../register/index.ts";
import { registerTestApp } from "./expect-forgotten.ts";
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
   * Defaults to the in-memory adapter.
   */
  readonly adapter?: Adapter;
  readonly logger?: Logger;
  /**
   * Where the fixed clock starts. Defaults to 2026-01-01T00:00:00Z.
   */
  readonly now?: Date;
  /**
   * The name of the store, which an implementation `ports` names receives in `create` as
   * `tenant`, as it would in that tenant's Durable Object. Left out, it receives none.
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
  // What `expectForgotten` searches once a person is forgotten: every adapter's tables, and what
  // the witness saw on the way in, which their tables no longer show.
  const witness = testWitnessOf(adapter);
  const readModels = Object.entries(config.readModels ?? {});
  const adapters = [adapter, ...readModels.map(([, store]) => store)]
    .filter(isAdapter)
    .filter((store, index, all) => all.indexOf(store) === index);
  // A reaction's failure stays in its dead letter, so the first port read without a value is
  // kept here for `runUntilIdle` to throw: the test fails saying what to pass.
  let missing: ConfigurationError | SnapshotError | undefined;
  const ledgers: ForgetLedger[] = [];
  const ledger = config.runtime?.personalData?.forgetLedger;
  const app = await assembleApp<R>({
    registry,
    // Required by the `Config` of a project whose ports need a choice, and never read here:
    // `test` replaces it.
    config: {
      ...config,
      runtime: {
        ...config.runtime,
        telemetry: { errorText: "include", ...config.runtime?.telemetry },
        // The same observed adapter as the storage's when it is the storage's, which the app
        // refuses.
        ...(ledger === undefined || !isAdapter(ledger.store)
          ? {}
          : {
              personalData: {
                ...config.runtime?.personalData,
                forgetLedger: { ...ledger, store: witness.storage(ledger.store) },
              },
            }),
      },
      storage: witness.storage(adapter),
      ...(config.readModels === undefined
        ? {}
        : {
            readModels: Object.fromEntries(
              readModels.map(([name, store]) => [
                name,
                isAdapter(store) ? witness.storage(store) : store,
              ]),
            ),
          }),
      ports: {} as AppPortsConfig,
    },
    logger: witness.logger(logger),
    witness: {
      onPersonalKey: witness.onPersonalKey,
      onForgetLedger: (opened) => {
        ledgers.push(opened);
      },
    },
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
  registerTestApp(tested, { witness, adapters, ledgers });
  return { app: tested, clock, ids };
};

export { createFixedClock, type FixedClock } from "../contracts/clock.ts";
export { createSequentialIdGenerator } from "../contracts/ids.ts";
export { silentLogger } from "../contracts/logger.ts";
export { memory } from "../memory/index.ts";
export type {
  ExpectForgottenFunction,
  ExpectForgottenOptions,
  ExpectForgottenTarget,
  ForgottenValueFound,
} from "./expect-forgotten.ts";
export { expectForgotten, NotForgottenError } from "./expect-forgotten.ts";
export { MIN_SUBSTRING_LENGTH } from "./search.ts";
export type {
  RecordedSpan,
  RecordedSpanEvent,
  RecordTelemetryFunction,
  TelemetryRecording,
} from "./telemetry.ts";
export { recordTelemetry } from "./telemetry.ts";
