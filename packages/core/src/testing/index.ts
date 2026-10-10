import type { Adapter } from "../adapter/adapter.ts";
import type { Config } from "../config/types.ts";
import { createFixedClock, type FixedClock } from "../contracts/clock.ts";
import type { ConfigurationError } from "../contracts/errors.ts";
import { createSequentialIdGenerator, type IdGenerator } from "../contracts/ids.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import { assembleApp, type BoundaApp } from "../kernel/app.ts";
import { createPendingRetries } from "../kernel/shared/pending-retries.ts";
import { memory } from "../memory/index.ts";
import type { Registry } from "../modules/registry.ts";
import type { AppPortsConfig, AppTestPorts, EnvSection } from "../register/index.ts";

/**
 * `env` is what port implementations receive in `create`, never the test's
 * `process.env`; `EnvSection` says when it is required.
 */
export type CreateTestAppArgs<R extends Registry> = {
  readonly registry: R;
  /**
   * Configuration without `storage`, which `adapter` replaces, nor `ports`, which the
   * option of that name replaces.
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
} & EnvSection<R>;

/**
 * A test app and what it runs on. Stop it with `app.stop()` when the test ends.
 */
export interface TestApp<R extends Registry> {
  /**
   * The app, whose `runUntilIdle()` throws the `ConfigurationError` of a port the test left out
   * once a handler has read it.
   */
  readonly app: BoundaApp<R>;
  /**
   * The app's clock. Advance it to make scheduled commands and process time-outs due, then call
   * `app.runUntilIdle()`, which moves it on its own only while a retry waits for its back-off: to
   * that retry, stopping first at what falls due before it.
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
}: CreateTestAppArgs<R>): Promise<TestApp<R>> => {
  const clock = createFixedClock(now);
  const ids = createSequentialIdGenerator();
  // A reaction's failure stays in its dead letter, so the first port read without a value is
  // kept here for `runUntilIdle` to throw: the test fails saying what to pass.
  let missing: ConfigurationError | undefined;
  const app = await assembleApp<R>({
    registry,
    // Required by the `Config` of a project whose ports need a choice, and never read here:
    // `test` replaces it.
    config: { ...config, storage: adapter, ports: {} as AppPortsConfig },
    logger,
    ids,
    clock,
    env,
    tenant,
    pendingRetries: createPendingRetries(clock),
    test: {
      ports,
      onMissing: (error) => {
        missing ??= error;
      },
    },
  });
  return {
    app: {
      ...app,
      runUntilIdle: async (options) => {
        const result = await app.runUntilIdle(options);
        if (missing !== undefined) throw missing;
        return result;
      },
    },
    clock,
    ids,
  };
};

export { createFixedClock, type FixedClock } from "../contracts/clock.ts";
export { createSequentialIdGenerator } from "../contracts/ids.ts";
export { silentLogger } from "../contracts/logger.ts";
export { memory } from "../memory/index.ts";
